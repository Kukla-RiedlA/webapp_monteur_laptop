<?php
declare(strict_types=1);

namespace App;

use InvalidArgumentException;

final class DispoPayloadValidator
{
    /**
     * @return array{
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
     * }
     */
    public function validateAndNormalize(array $payload): array
    {
        $sourceSystem = $this->firstString($payload, ['sourceSystem', 'source_system', 'source'], true);
        $correlationId = $this->firstString($payload, ['correlationId', 'correlation_id', 'requestId', 'messageId'], false)
            ?: bin2hex(random_bytes(8));

        $jobs = $this->extractCollection($payload, [
            ['jobs'],
            ['orders'],
            ['auftraege'],
            ['data', 'jobs'],
            ['data', 'orders'],
            ['data', 'auftraege'],
        ]);
        $absences = $this->extractCollection($payload, [
            ['absences'],
            ['vacations'],
            ['abwesenheiten'],
            ['data', 'absences'],
            ['data', 'vacations'],
            ['data', 'abwesenheiten'],
        ]);
        $assignments = $this->extractCollection($payload, [
            ['assignments'],
            ['jobAssignments'],
            ['zuweisungen'],
            ['data', 'assignments'],
            ['data', 'jobAssignments'],
            ['data', 'zuweisungen'],
        ]);

        if (count($jobs) === 0 && count($absences) === 0 && count($assignments) === 0) {
            throw new InvalidArgumentException(
                'Keine verarbeitbaren Daten gefunden. Erwartet wird mindestens jobs, absences oder assignments.'
            );
        }

        $normalizedJobs = $this->normalizeJobs($jobs);
        $normalizedAbsences = $this->normalizeAbsences($absences);
        $normalizedAssignments = $this->normalizeAssignments($assignments);

        return [
            'sourceSystem' => $sourceSystem,
            'correlationId' => $correlationId,
            'jobs' => $normalizedJobs,
            'absences' => $normalizedAbsences,
            'assignments' => $normalizedAssignments,
        ];
    }

    /**
     * @param array<int, mixed> $jobs
     * @return array<int, array{
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
     * }>
     */
    private function normalizeJobs(array $jobs): array
    {
        $normalizedJobs = [];
        foreach ($jobs as $index => $job) {
            if (!is_array($job)) {
                throw new InvalidArgumentException(sprintf('jobs[%d] muss ein Objekt sein.', $index));
            }

            $address = $this->firstArray($job, ['address', 'adresse']) ?? [];
            $schedule = $this->firstArray($job, ['schedule', 'termin']) ?? [];

            $priority = $this->mapPriority($this->firstString($job, ['priority', 'prio', 'prioritaet'], false) ?? 'normal');
            $status = $this->mapStatus($this->firstString($job, ['status', 'state'], false) ?? 'planned');

            $normalizedJobs[] = [
                'jobId' => $this->firstString($job, ['jobId', 'job_id', 'id', 'auftragId', 'auftrag_id', 'externalId'], true),
                'customerName' => $this->firstString($job, ['customerName', 'customer_name', 'kunde', 'kundenname'], true),
                'addressStreet' => $this->firstString($address, ['street', 'strasse'], false),
                'addressPostalCode' => $this->firstString($address, ['postalCode', 'plz', 'zip'], false),
                'addressCity' => $this->firstString($address, ['city', 'ort'], false),
                'scheduledDate' => $this->firstString($schedule, ['date', 'datum', 'scheduledDate', 'scheduled_date'], false),
                'scheduledFrom' => $this->firstString($schedule, ['from', 'von', 'start', 'startTime'], false),
                'scheduledTo' => $this->firstString($schedule, ['to', 'bis', 'end', 'endTime'], false),
                'priority' => $priority,
                'status' => $status,
                'technicianCode' => $this->firstString($job, ['technicianCode', 'technician_code', 'monteurCode', 'monteur_id'], false),
                'rawJobJson' => json_encode($job, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: '{}',
            ];
        }
        return $normalizedJobs;
    }

    /**
     * @param array<int, mixed> $absences
     * @return array<int, array{
     *   absenceId:string,
     *   technicianCode:string,
     *   dateFrom:string,
     *   dateTo:string,
     *   type:string,
     *   note:?string,
     *   rawAbsenceJson:string
     * }>
     */
    private function normalizeAbsences(array $absences): array
    {
        $normalizedAbsences = [];
        foreach ($absences as $index => $absence) {
            if (!is_array($absence)) {
                throw new InvalidArgumentException(sprintf('absences[%d] muss ein Objekt sein.', $index));
            }

            $technicianCode = $this->firstString($absence, ['technicianCode', 'technician_code', 'monteurCode', 'monteur_id'], true);
            $dateFrom = $this->firstString($absence, ['dateFrom', 'from', 'von', 'startDate', 'start_date'], true);
            $dateTo = $this->firstString($absence, ['dateTo', 'to', 'bis', 'endDate', 'end_date'], true);
            $type = $this->mapAbsenceType($this->firstString($absence, ['type', 'absenceType', 'grund'], false) ?? 'vacation');
            $absenceId = $this->firstString($absence, ['absenceId', 'absence_id', 'id', 'externalId'], false)
                ?? sha1($technicianCode . '|' . $dateFrom . '|' . $dateTo . '|' . $type);

            $normalizedAbsences[] = [
                'absenceId' => $absenceId,
                'technicianCode' => $technicianCode,
                'dateFrom' => $dateFrom,
                'dateTo' => $dateTo,
                'type' => $type,
                'note' => $this->firstString($absence, ['note', 'bemerkung', 'reason'], false),
                'rawAbsenceJson' => json_encode($absence, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: '{}',
            ];
        }
        return $normalizedAbsences;
    }

    /**
     * @param array<int, mixed> $assignments
     * @return array<int, array{
     *   assignmentId:string,
     *   jobId:string,
     *   technicianCode:string,
     *   role:?string,
     *   rawAssignmentJson:string
     * }>
     */
    private function normalizeAssignments(array $assignments): array
    {
        $normalizedAssignments = [];
        foreach ($assignments as $index => $assignment) {
            if (!is_array($assignment)) {
                throw new InvalidArgumentException(sprintf('assignments[%d] muss ein Objekt sein.', $index));
            }

            $jobId = $this->firstString($assignment, ['jobId', 'job_id', 'auftragId', 'auftrag_id'], true);
            $technicianCode = $this->firstString($assignment, ['technicianCode', 'technician_code', 'monteurCode', 'monteur_id'], true);
            $assignmentId = $this->firstString($assignment, ['assignmentId', 'assignment_id', 'id', 'externalId'], false)
                ?? sha1($jobId . '|' . $technicianCode);

            $normalizedAssignments[] = [
                'assignmentId' => $assignmentId,
                'jobId' => $jobId,
                'technicianCode' => $technicianCode,
                'role' => $this->firstString($assignment, ['role', 'rolle'], false),
                'rawAssignmentJson' => json_encode($assignment, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: '{}',
            ];
        }
        return $normalizedAssignments;
    }

    private function mapPriority(string $priority): string
    {
        $normalized = strtolower(trim($priority));
        return match ($normalized) {
            'low', 'niedrig' => 'low',
            'high', 'hoch', 'urgent', 'dringend' => 'high',
            default => 'normal',
        };
    }

    private function mapStatus(string $status): string
    {
        $normalized = strtolower(trim($status));
        return match ($normalized) {
            'planned', 'geplant' => 'planned',
            'in_progress', 'in arbeit', 'in_arbeit', 'running' => 'in_progress',
            'done', 'erledigt', 'completed' => 'done',
            'cancelled', 'storniert', 'abgesagt' => 'cancelled',
            default => 'planned',
        };
    }

    private function mapAbsenceType(string $type): string
    {
        $normalized = strtolower(trim($type));
        return match ($normalized) {
            'urlaub', 'vacation', 'holiday' => 'vacation',
            'krank', 'sick', 'sickness' => 'sick',
            default => 'other',
        };
    }

    /**
     * @param array<int, array<int, string>> $paths
     * @return array<int, mixed>
     */
    private function extractCollection(array $payload, array $paths): array
    {
        foreach ($paths as $path) {
            $value = $this->getValueByPath($payload, $path);
            if (is_array($value)) {
                return array_values($value);
            }
        }
        return [];
    }

    /**
     * @param array<int, string> $keys
     */
    private function firstString(array $data, array $keys, bool $required): ?string
    {
        foreach ($keys as $key) {
            if (!array_key_exists($key, $data)) {
                continue;
            }
            $value = $data[$key];
            if (!is_string($value)) {
                throw new InvalidArgumentException(sprintf('Feld "%s" muss ein String sein.', $key));
            }
            $trimmed = trim($value);
            if ($trimmed !== '') {
                return $trimmed;
            }
        }

        if ($required) {
            throw new InvalidArgumentException(sprintf('Eines der Felder [%s] ist erforderlich.', implode(', ', $keys)));
        }

        return null;
    }

    /**
     * @param array<int, string> $keys
     */
    private function firstArray(array $data, array $keys): ?array
    {
        foreach ($keys as $key) {
            if (!array_key_exists($key, $data)) {
                continue;
            }
            if (!is_array($data[$key])) {
                throw new InvalidArgumentException(sprintf('Feld "%s" muss ein Objekt sein.', $key));
            }
            return $data[$key];
        }
        return null;
    }

    /**
     * @param array<int, string> $path
     */
    private function getValueByPath(array $data, array $path): mixed
    {
        $current = $data;
        foreach ($path as $segment) {
            if (!is_array($current) || !array_key_exists($segment, $current)) {
                return null;
            }
            $current = $current[$segment];
        }
        return $current;
    }
}
