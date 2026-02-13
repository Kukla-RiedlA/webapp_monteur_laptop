<?php
declare(strict_types=1);

namespace App;

use PDO;

/**
 * Liest und schreibt in der Dispo-DB (fsm) – für Monteure.
 * Technician = users.id mit role 'monteur'; Zuordnung über job_technicians.
 */
final class DispoRepository
{
    public function __construct(private readonly PDO $fsm)
    {
    }

    /**
     * Aufträge des Monteurs (mit Adresse und Kunde).
     * Optional nach Datum filtern (start_datetime der Jobs).
     *
     * @return list<array<string, mixed>>
     */
    public function getJobsForTechnician(int $technicianId, ?string $dateFrom = null, ?string $dateTo = null): array
    {
        $sql = 'SELECT j.id, j.job_number, j.customer_id, j.job_type, j.start_datetime, j.end_datetime,
                       j.status, j.required_technicians, j.description, j.fabrikationsnummern,
                       c.name AS customer_name, c.phone AS customer_phone, c.contact_person, c.contact_phone,
                       ja.street, ja.house_number, ja.zip, ja.city, ja.country, ja.address_extra_1, ja.address_extra_2
                FROM jobs j
                INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = :technician_id
                INNER JOIN customers c ON c.id = j.customer_id
                LEFT JOIN job_addresses ja ON ja.job_id = j.id
                WHERE 1=1';
        $params = [':technician_id' => $technicianId];

        if ($dateFrom !== null && $dateFrom !== '') {
            $sql .= ' AND j.start_datetime >= :date_from';
            $params[':date_from'] = $dateFrom . ' 00:00:00';
        }
        if ($dateTo !== null && $dateTo !== '') {
            $sql .= ' AND j.start_datetime <= :date_to';
            $params[':date_to'] = $dateTo . ' 23:59:59';
        }

        $sql .= ' ORDER BY j.start_datetime ASC';

        $stmt = $this->fsm->prepare($sql);
        $stmt->execute($params);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        return is_array($rows) ? $rows : [];
    }

    /**
     * Ein Auftrag inkl. Adresse und Kunde (nur wenn Monteur zugeordnet).
     *
     * @return array<string, mixed>|null
     */
    public function getJobByIdForTechnician(int $jobId, int $technicianId): ?array
    {
        $sql = 'SELECT j.id, j.job_number, j.customer_id, j.job_type, j.start_datetime, j.end_datetime,
                       j.status, j.required_technicians, j.description, j.fabrikationsnummern, j.eap_nummer, j.bestellnummer,
                       c.name AS customer_name, c.street AS customer_street, c.house_number AS customer_house_number,
                       c.zip AS customer_zip, c.city AS customer_city, c.phone AS customer_phone,
                       c.contact_person, c.contact_phone, c.contact_email,
                       ja.street, ja.house_number, ja.zip, ja.city, ja.country, ja.address_extra_1, ja.address_extra_2
                FROM jobs j
                INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = :technician_id
                INNER JOIN customers c ON c.id = j.customer_id
                LEFT JOIN job_addresses ja ON ja.job_id = j.id
                WHERE j.id = :job_id';
        $stmt = $this->fsm->prepare($sql);
        $stmt->execute([
            ':job_id' => $jobId,
            ':technician_id' => $technicianId,
        ]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return is_array($row) ? $row : null;
    }

    /**
     * Status eines Auftrags setzen (nur wenn Monteur zugeordnet).
     * Erlaubte Werte: geplant, in_arbeit, erledigt.
     */
    public function updateJobStatus(int $jobId, int $technicianId, string $status, ?int $updatedBy = null): bool
    {
        $allowed = ['geplant', 'in_arbeit', 'erledigt'];
        if (!in_array($status, $allowed, true)) {
            return false;
        }

        $sql = 'UPDATE jobs j
                INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = :technician_id
                SET j.status = :status, j.updated_at = NOW(), j.updated_by = :updated_by
                WHERE j.id = :job_id';
        $stmt = $this->fsm->prepare($sql);
        $stmt->execute([
            ':job_id' => $jobId,
            ':technician_id' => $technicianId,
            ':status' => $status,
            ':updated_by' => $updatedBy ?? $technicianId,
        ]);
        return $stmt->rowCount() > 0;
    }

    /**
     * Beschreibung eines Auftrags aktualisieren (nur wenn Monteur zugeordnet).
     */
    public function updateJobDescription(int $jobId, int $technicianId, string $description, ?int $updatedBy = null): bool
    {
        $sql = 'UPDATE jobs j
                INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = :technician_id
                SET j.description = :description, j.updated_at = NOW(), j.updated_by = :updated_by
                WHERE j.id = :job_id';
        $stmt = $this->fsm->prepare($sql);
        $stmt->execute([
            ':job_id' => $jobId,
            ':technician_id' => $technicianId,
            ':description' => $description,
            ':updated_by' => $updatedBy ?? $technicianId,
        ]);
        return $stmt->rowCount() > 0;
    }

    /**
     * Abwesenheiten des Monteurs.
     *
     * @return list<array<string, mixed>>
     */
    public function getAbsencesForTechnician(int $technicianId, ?string $dateFrom = null, ?string $dateTo = null): array
    {
        $sql = 'SELECT id, technician_id, start_datetime, end_datetime, type
                FROM absences
                WHERE technician_id = :technician_id';
        $params = [':technician_id' => $technicianId];

        if ($dateFrom !== null && $dateFrom !== '') {
            $sql .= ' AND end_datetime >= :date_from';
            $params[':date_from'] = $dateFrom . ' 00:00:00';
        }
        if ($dateTo !== null && $dateTo !== '') {
            $sql .= ' AND start_datetime <= :date_to';
            $params[':date_to'] = $dateTo . ' 23:59:59';
        }

        $sql .= ' ORDER BY start_datetime ASC';

        $stmt = $this->fsm->prepare($sql);
        $stmt->execute($params);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        return is_array($rows) ? $rows : [];
    }

    /**
     * Eine Abwesenheit anlegen.
     * start_datetime / end_datetime Format: Y-m-d H:i:s oder Y-m-d
     */
    public function createAbsence(int $technicianId, string $startDatetime, string $endDatetime, ?string $type = null): int
    {
        $start = $this->normalizeDatetime($startDatetime);
        $end = $this->normalizeDatetime($endDatetime);
        $sql = 'INSERT INTO absences (technician_id, start_datetime, end_datetime, type)
                VALUES (:technician_id, :start_datetime, :end_datetime, :type)';
        $stmt = $this->fsm->prepare($sql);
        $stmt->execute([
            ':technician_id' => $technicianId,
            ':start_datetime' => $start,
            ':end_datetime' => $end,
            ':type' => $type ?? '',
        ]);
        return (int) $this->fsm->lastInsertId();
    }

    /**
     * Abwesenheit aktualisieren (nur eigene).
     */
    public function updateAbsence(int $absenceId, int $technicianId, string $startDatetime, string $endDatetime, ?string $type = null): bool
    {
        $start = $this->normalizeDatetime($startDatetime);
        $end = $this->normalizeDatetime($endDatetime);
        $sql = 'UPDATE absences
                SET start_datetime = :start_datetime, end_datetime = :end_datetime, type = :type
                WHERE id = :id AND technician_id = :technician_id';
        $stmt = $this->fsm->prepare($sql);
        $stmt->execute([
            ':id' => $absenceId,
            ':technician_id' => $technicianId,
            ':start_datetime' => $start,
            ':end_datetime' => $end,
            ':type' => $type ?? '',
        ]);
        return $stmt->rowCount() > 0;
    }

    /**
     * Abwesenheit löschen (nur eigene).
     */
    public function deleteAbsence(int $absenceId, int $technicianId): bool
    {
        $sql = 'DELETE FROM absences WHERE id = :id AND technician_id = :technician_id';
        $stmt = $this->fsm->prepare($sql);
        $stmt->execute([':id' => $absenceId, ':technician_id' => $technicianId]);
        return $stmt->rowCount() > 0;
    }

    /**
     * Prüfen, ob userId ein Monteur ist und aktiv.
     */
    public function isTechnician(int $userId): bool
    {
        $sql = 'SELECT 1 FROM users WHERE id = :id AND role = \'monteur\' AND active = 1';
        $stmt = $this->fsm->prepare($sql);
        $stmt->execute([':id' => $userId]);
        return $stmt->fetchColumn() !== false;
    }

    /**
     * Monteur anhand ID holen (für Anzeige Name in der App).
     *
     * @return array{id: int, username: string, full_name: string}|null
     */
    public function getTechnicianById(int $technicianId): ?array
    {
        $sql = 'SELECT id, username, full_name FROM users WHERE id = :id AND role = \'monteur\' AND active = 1';
        $stmt = $this->fsm->prepare($sql);
        $stmt->execute([':id' => $technicianId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return is_array($row) ? $row : null;
    }

    /**
     * Monteur anhand username holen (für Login).
     *
     * @return array{id: int, username: string, full_name: string}|null
     */
    public function getTechnicianByUsername(string $username): ?array
    {
        $sql = 'SELECT id, username, full_name FROM users WHERE username = :username AND role = \'monteur\' AND active = 1';
        $stmt = $this->fsm->prepare($sql);
        $stmt->execute([':username' => $username]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return is_array($row) ? $row : null;
    }

    private function normalizeDatetime(string $value): string
    {
        $value = trim($value);
        if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $value)) {
            return $value . ' 00:00:00';
        }
        if (preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/', $value)) {
            return $value;
        }
        return $value . ' 00:00:00';
    }
}
