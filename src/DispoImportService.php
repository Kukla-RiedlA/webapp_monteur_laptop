<?php
declare(strict_types=1);

namespace App;

use PDO;
use Throwable;

final class DispoImportService
{
    public function __construct(private readonly PDO $pdo)
    {
    }

    /**
     * @param array{
     *   sourceSystem:string,
     *   correlationId:string,
     *   jobs:array<int, array{
     *     jobId:string,
     *     customerName:string,
     *     addressStreet:?string,
     *     addressPostalCode:?string,
     *     addressCity:?string,
     *     scheduledDate:?string,
     *     scheduledFrom:?string,
     *     scheduledTo:?string,
     *     priority:string,
     *     status:string,
     *     technicianCode:?string,
     *     rawJobJson:string
     *   }>,
     *   absences:array<int, array{
     *     absenceId:string,
     *     technicianCode:string,
     *     dateFrom:string,
     *     dateTo:string,
     *     type:string,
     *     note:?string,
     *     rawAbsenceJson:string
     *   }>,
     *   assignments:array<int, array{
     *     assignmentId:string,
     *     jobId:string,
     *     technicianCode:string,
     *     role:?string,
     *     rawAssignmentJson:string
     *   }>
     * } $normalizedPayload
     * @param array<mixed> $rawPayload
     * @return array{
     *   batchId:int,
     *   processedJobs:int,
     *   processedAbsences:int,
     *   processedAssignments:int,
     *   idempotent:bool
     * }
     */
    public function import(array $normalizedPayload, array $rawPayload): array
    {
        $sourceSystem = $normalizedPayload['sourceSystem'];
        $correlationId = $normalizedPayload['correlationId'];
        $payloadHash = hash(
            'sha256',
            json_encode($rawPayload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: '{}'
        );

        $existingBatch = $this->findBatchByCorrelation($sourceSystem, $correlationId);
        if ($existingBatch !== null && $existingBatch['processing_status'] === 'processed') {
            return [
                'batchId' => (int) $existingBatch['id'],
                'processedJobs' => (int) $existingBatch['processed_jobs'],
                'processedAbsences' => (int) $existingBatch['processed_absences'],
                'processedAssignments' => (int) $existingBatch['processed_assignments'],
                'idempotent' => true,
            ];
        }

        $batchId = $existingBatch !== null
            ? $this->prepareBatchRetry((int) $existingBatch['id'], $rawPayload, $payloadHash)
            : $this->createBatch($sourceSystem, $correlationId, $rawPayload, $payloadHash);

        try {
            $this->pdo->beginTransaction();

            $processedJobs = 0;
            foreach ($normalizedPayload['jobs'] as $job) {
                $this->upsertJob($job);
                $processedJobs++;
            }

            $processedAbsences = 0;
            foreach ($normalizedPayload['absences'] as $absence) {
                $this->upsertAbsence($absence);
                $processedAbsences++;
            }

            $processedAssignments = 0;
            foreach ($normalizedPayload['assignments'] as $assignment) {
                $this->upsertAssignment($assignment);
                $processedAssignments++;
            }

            $this->markBatchProcessed($batchId, $processedJobs, $processedAbsences, $processedAssignments);
            $this->pdo->commit();

            return [
                'batchId' => $batchId,
                'processedJobs' => $processedJobs,
                'processedAbsences' => $processedAbsences,
                'processedAssignments' => $processedAssignments,
                'idempotent' => false,
            ];
        } catch (Throwable $e) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            $this->markBatchFailed($batchId, $e->getMessage());
            throw $e;
        }
    }

    /**
     * @param array<mixed> $payload
     */
    private function createBatch(string $sourceSystem, string $correlationId, array $payload, string $payloadHash): int
    {
        $sql = 'INSERT INTO dispo_import_batches
                (source_system, correlation_id, payload_hash, payload_json, processing_status, received_at)
                VALUES (:source_system, :correlation_id, :payload_hash, :payload_json, :processing_status, NOW())';
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute([
            ':source_system' => $sourceSystem,
            ':correlation_id' => $correlationId,
            ':payload_hash' => $payloadHash,
            ':payload_json' => json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            ':processing_status' => 'pending',
        ]);

        return (int) $this->pdo->lastInsertId();
    }

    /**
     * @return array{
     *   id:int|string,
     *   processing_status:string,
     *   processed_jobs:int|string,
     *   processed_absences:int|string,
     *   processed_assignments:int|string
     * }|null
     */
    private function findBatchByCorrelation(string $sourceSystem, string $correlationId): ?array
    {
        $sql = 'SELECT id, processing_status, processed_jobs, processed_absences, processed_assignments
                FROM dispo_import_batches
                WHERE source_system = :source_system AND correlation_id = :correlation_id
                LIMIT 1';
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute([
            ':source_system' => $sourceSystem,
            ':correlation_id' => $correlationId,
        ]);
        $row = $stmt->fetch();

        return is_array($row) ? $row : null;
    }

    /**
     * @param array<mixed> $payload
     */
    private function prepareBatchRetry(int $batchId, array $payload, string $payloadHash): int
    {
        $sql = 'UPDATE dispo_import_batches
                SET payload_hash = :payload_hash,
                    payload_json = :payload_json,
                    processing_status = :processing_status,
                    processed_jobs = 0,
                    processed_absences = 0,
                    processed_assignments = 0,
                    error_message = NULL
                WHERE id = :id';
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute([
            ':payload_hash' => $payloadHash,
            ':payload_json' => json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            ':processing_status' => 'pending',
            ':id' => $batchId,
        ]);
        return $batchId;
    }

    /**
     * @param array{
     *   jobId:string,
     *   customerName:string,
     *   addressStreet:?string,
     *   addressPostalCode:?string,
     *   addressCity:?string,
     *   scheduledDate:?string,
     *   scheduledFrom:?string,
     *   scheduledTo:?string,
     *   priority:string,
     *   status:string,
     *   technicianCode:?string,
     *   rawJobJson:string
     * } $job
     */
    private function upsertJob(array $job): void
    {
        $sql = 'INSERT INTO dispo_jobs (
                    external_job_id,
                    customer_name,
                    address_street,
                    address_postal_code,
                    address_city,
                    scheduled_date,
                    scheduled_time_from,
                    scheduled_time_to,
                    priority,
                    status,
                    technician_code,
                    raw_job_json,
                    updated_at
                ) VALUES (
                    :external_job_id,
                    :customer_name,
                    :address_street,
                    :address_postal_code,
                    :address_city,
                    :scheduled_date,
                    :scheduled_time_from,
                    :scheduled_time_to,
                    :priority,
                    :status,
                    :technician_code,
                    :raw_job_json,
                    NOW()
                )
                ON DUPLICATE KEY UPDATE
                    customer_name = VALUES(customer_name),
                    address_street = VALUES(address_street),
                    address_postal_code = VALUES(address_postal_code),
                    address_city = VALUES(address_city),
                    scheduled_date = VALUES(scheduled_date),
                    scheduled_time_from = VALUES(scheduled_time_from),
                    scheduled_time_to = VALUES(scheduled_time_to),
                    priority = VALUES(priority),
                    status = VALUES(status),
                    technician_code = VALUES(technician_code),
                    raw_job_json = VALUES(raw_job_json),
                    updated_at = NOW()';

        $stmt = $this->pdo->prepare($sql);
        $stmt->execute([
            ':external_job_id' => $job['jobId'],
            ':customer_name' => $job['customerName'],
            ':address_street' => $job['addressStreet'],
            ':address_postal_code' => $job['addressPostalCode'],
            ':address_city' => $job['addressCity'],
            ':scheduled_date' => $job['scheduledDate'],
            ':scheduled_time_from' => $job['scheduledFrom'],
            ':scheduled_time_to' => $job['scheduledTo'],
            ':priority' => $job['priority'],
            ':status' => $job['status'],
            ':technician_code' => $job['technicianCode'],
            ':raw_job_json' => $job['rawJobJson'],
        ]);
    }

    /**
     * @param array{
     *   absenceId:string,
     *   technicianCode:string,
     *   dateFrom:string,
     *   dateTo:string,
     *   type:string,
     *   note:?string,
     *   rawAbsenceJson:string
     * } $absence
     */
    private function upsertAbsence(array $absence): void
    {
        $sql = 'INSERT INTO dispo_absences (
                    external_absence_id,
                    technician_code,
                    date_from,
                    date_to,
                    type,
                    note,
                    raw_absence_json,
                    updated_at
                ) VALUES (
                    :external_absence_id,
                    :technician_code,
                    :date_from,
                    :date_to,
                    :type,
                    :note,
                    :raw_absence_json,
                    NOW()
                )
                ON DUPLICATE KEY UPDATE
                    technician_code = VALUES(technician_code),
                    date_from = VALUES(date_from),
                    date_to = VALUES(date_to),
                    type = VALUES(type),
                    note = VALUES(note),
                    raw_absence_json = VALUES(raw_absence_json),
                    updated_at = NOW()';

        $stmt = $this->pdo->prepare($sql);
        $stmt->execute([
            ':external_absence_id' => $absence['absenceId'],
            ':technician_code' => $absence['technicianCode'],
            ':date_from' => $absence['dateFrom'],
            ':date_to' => $absence['dateTo'],
            ':type' => $absence['type'],
            ':note' => $absence['note'],
            ':raw_absence_json' => $absence['rawAbsenceJson'],
        ]);
    }

    /**
     * @param array{
     *   assignmentId:string,
     *   jobId:string,
     *   technicianCode:string,
     *   role:?string,
     *   rawAssignmentJson:string
     * } $assignment
     */
    private function upsertAssignment(array $assignment): void
    {
        $sql = 'INSERT INTO dispo_job_assignments (
                    external_assignment_id,
                    external_job_id,
                    technician_code,
                    role,
                    raw_assignment_json,
                    updated_at
                ) VALUES (
                    :external_assignment_id,
                    :external_job_id,
                    :technician_code,
                    :role,
                    :raw_assignment_json,
                    NOW()
                )
                ON DUPLICATE KEY UPDATE
                    external_job_id = VALUES(external_job_id),
                    technician_code = VALUES(technician_code),
                    role = VALUES(role),
                    raw_assignment_json = VALUES(raw_assignment_json),
                    updated_at = NOW()';

        $stmt = $this->pdo->prepare($sql);
        $stmt->execute([
            ':external_assignment_id' => $assignment['assignmentId'],
            ':external_job_id' => $assignment['jobId'],
            ':technician_code' => $assignment['technicianCode'],
            ':role' => $assignment['role'],
            ':raw_assignment_json' => $assignment['rawAssignmentJson'],
        ]);
    }

    private function markBatchProcessed(
        int $batchId,
        int $processedJobs,
        int $processedAbsences,
        int $processedAssignments
    ): void
    {
        $sql = 'UPDATE dispo_import_batches
                SET processing_status = :processing_status,
                    processed_jobs = :processed_jobs,
                    processed_absences = :processed_absences,
                    processed_assignments = :processed_assignments,
                    error_message = NULL
                WHERE id = :id';
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute([
            ':processing_status' => 'processed',
            ':processed_jobs' => $processedJobs,
            ':processed_absences' => $processedAbsences,
            ':processed_assignments' => $processedAssignments,
            ':id' => $batchId,
        ]);
    }

    private function markBatchFailed(int $batchId, string $errorMessage): void
    {
        $sql = 'UPDATE dispo_import_batches
                SET processing_status = :processing_status,
                    error_message = :error_message
                WHERE id = :id';
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute([
            ':processing_status' => 'failed',
            ':error_message' => substr($errorMessage, 0, 2000),
            ':id' => $batchId,
        ]);
    }
}
