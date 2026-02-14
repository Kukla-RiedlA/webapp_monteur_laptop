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
                       j.status, j.required_technicians, j.description, j.fabrikationsnummern, j.eap_nummer, j.bestellnummer,
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
        if ($rows === []) {
            return [];
        }
        $jobIds = array_map(fn ($r) => (int) $r['id'], $rows);
        $placeholders = implode(',', array_fill(0, count($jobIds), '?'));
        $fabSql = "SELECT job_id, fabrikationsnummer, type, baujahr, leistung, nenngeschwindigkeit, kraftaufnehmer, dms_nr, tacho, elektronik, material, position
                   FROM job_fabrikation WHERE job_id IN ($placeholders) ORDER BY job_id, id";
        $fabStmt = $this->fsm->prepare($fabSql);
        $fabStmt->execute($jobIds);
        $fabByJob = [];
        while (($fr = $fabStmt->fetch(PDO::FETCH_ASSOC)) !== false) {
            $jid = (int) $fr['job_id'];
            unset($fr['job_id']);
            if (!isset($fabByJob[$jid])) {
                $fabByJob[$jid] = [];
            }
            $fabByJob[$jid][] = $fr;
        }
        foreach ($rows as &$job) {
            $jid = (int) $job['id'];
            if (isset($fabByJob[$jid]) && $fabByJob[$jid] !== []) {
                $job['fabrikationsnummern'] = json_encode($fabByJob[$jid], JSON_UNESCAPED_UNICODE);
            } else {
                $fabFromJob = $this->parseFabrikationsnummernFromJob($job['fabrikationsnummern'] ?? '');
                if ($fabFromJob !== []) {
                    $job['fabrikationsnummern'] = json_encode($this->enrichFabFromAnlagenstamm($fabFromJob), JSON_UNESCAPED_UNICODE);
                }
            }
        }
        unset($job);
        return $rows;
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
        if (!is_array($row)) {
            return null;
        }
        // Leistungsdaten: zuerst job_fabrikation, sonst Fabrikationsnummer vom Auftrag (jobs.fabrikationsnummern) + Anlagenstamm zuordnen
        $fabSql = 'SELECT fabrikationsnummer, type, baujahr, leistung, nenngeschwindigkeit, kraftaufnehmer, dms_nr, tacho, elektronik, material, position
                   FROM job_fabrikation WHERE job_id = :job_id ORDER BY id';
        $fabStmt = $this->fsm->prepare($fabSql);
        $fabStmt->execute([':job_id' => $jobId]);
        $fabRows = $fabStmt->fetchAll(PDO::FETCH_ASSOC);
        if ($fabRows !== []) {
            // Pro Zeile prüfen: wenn Details fehlen, aus Anlagenstamm nachziehen.
            $fabs = [];
            foreach ($fabRows as $fr) {
                $fab = trim((string) ($fr['fabrikationsnummer'] ?? ''));
                if ($fab !== '') {
                    $fabs[] = $fab;
                }
            }
            $enriched = [];
            if ($fabs !== []) {
                $enriched = $this->enrichFabFromAnlagenstamm($fabs);
            }
            $byFab = [];
            foreach ($enriched as $er) {
                $key = trim((string) ($er['fabrikationsnummer'] ?? ''));
                if ($key !== '') {
                    $byFab[$key] = $er;
                }
            }
            $resultFab = [];
            foreach ($fabRows as $fr) {
                $fab = trim((string) ($fr['fabrikationsnummer'] ?? ''));
                $base = $fr;
                $enr = $fab !== '' && isset($byFab[$fab]) ? $byFab[$fab] : null;
                // Für jede Spalte: wenn in job_fabrikation leer/NULL, Wert aus Anlagenstamm nehmen.
                foreach (['type', 'leistung', 'nenngeschwindigkeit', 'kraftaufnehmer', 'dms_nr', 'tacho', 'elektronik', 'material', 'position'] as $field) {
                    $cur = isset($base[$field]) ? trim((string) $base[$field]) : '';
                    if ($cur === '' && $enr !== null && isset($enr[$field])) {
                        $base[$field] = $enr[$field];
                    }
                }
                $resultFab[] = $base;
            }
            $row['fabrikationsnummern'] = json_encode($resultFab, JSON_UNESCAPED_UNICODE);
        } else {
            $fabFromJob = $this->parseFabrikationsnummernFromJob($row['fabrikationsnummern'] ?? '');
            if ($fabFromJob !== []) {
                $row['fabrikationsnummern'] = json_encode($this->enrichFabFromAnlagenstamm($fabFromJob), JSON_UNESCAPED_UNICODE);
            }
        }
        return $row;
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
     * Leistungsdaten (job_fabrikation) für einen Auftrag aktualisieren.
     *
     * @param list<array<string, mixed>> $rows
     */
    public function updateJobFabrikationsnummern(int $jobId, int $technicianId, array $rows, ?int $updatedBy = null): bool
    {
        // Prüfen, ob Auftrag dem Monteur zugeordnet ist
        $checkSql = 'SELECT j.id
                     FROM jobs j
                     INNER JOIN job_technicians jt ON jt.job_id = j.id AND jt.technician_id = :technician_id
                     WHERE j.id = :job_id';
        $checkStmt = $this->fsm->prepare($checkSql);
        $checkStmt->execute([':job_id' => $jobId, ':technician_id' => $technicianId]);
        if ($checkStmt->fetchColumn() === false) {
            return false;
        }

        $this->fsm->beginTransaction();
        try {
            // Alte Einträge entfernen
            $del = $this->fsm->prepare('DELETE FROM job_fabrikation WHERE job_id = :job_id');
            $del->execute([':job_id' => $jobId]);

            // Neue Einträge anlegen
            if ($rows !== []) {
                $ins = $this->fsm->prepare(
                    'INSERT INTO job_fabrikation (job_id, fabrikationsnummer, type, baujahr, leistung, nenngeschwindigkeit, kraftaufnehmer, dms_nr, tacho, elektronik, material, position)
                     VALUES (:job_id, :fab, :type, :baujahr, :leistung, :nenngeschwindigkeit, :kraftaufnehmer, :dms_nr, :tacho, :elektronik, :material, :position)'
                );
                $updFab = $this->fsm->prepare(
                    'UPDATE anlagenstamm
                     SET type = COALESCE(NULLIF(:type, \'\'), type),
                         leistung = COALESCE(NULLIF(:leistung, \'\'), leistung),
                         nenngeschwindigkeit = COALESCE(NULLIF(:nenngeschwindigkeit, \'\'), nenngeschwindigkeit),
                         kraftaufnehmer = COALESCE(NULLIF(:kraftaufnehmer, \'\'), kraftaufnehmer),
                         dms_nr = COALESCE(NULLIF(:dms_nr, \'\'), dms_nr),
                         tacho = COALESCE(NULLIF(:tacho, \'\'), tacho),
                         elektronik = COALESCE(NULLIF(:elektronik, \'\'), elektronik),
                         material = COALESCE(NULLIF(:material, \'\'), material),
                         position = COALESCE(NULLIF(:position, \'\'), position)
                     WHERE fabrikationsnummer = :fab'
                );
                foreach ($rows as $row) {
                    if (!is_array($row)) {
                        continue;
                    }
                    $fab = trim((string) ($row['fabrikationsnummer'] ?? $row['Fabrikationsnummer'] ?? ''));
                    if ($fab === '') {
                        continue;
                    }
                    $type = trim((string) ($row['type'] ?? ''));
                    $baujahr = trim((string) ($row['baujahr'] ?? ''));
                    $leistung = trim((string) ($row['leistung'] ?? ''));
                    $nenngeschwindigkeit = trim((string) ($row['nenngeschwindigkeit'] ?? ''));
                    $kraftaufnehmer = trim((string) ($row['kraftaufnehmer'] ?? ''));
                    $dms_nr = trim((string) ($row['dms_nr'] ?? ''));
                    $tacho = trim((string) ($row['tacho'] ?? ''));
                    $elektronik = trim((string) ($row['elektronik'] ?? ''));
                    $material = trim((string) ($row['material'] ?? ''));
                    $position = trim((string) ($row['position'] ?? ''));
                    $ins->execute([
                        ':job_id' => $jobId,
                        ':fab' => $fab,
                        ':type' => $type,
                        ':baujahr' => $baujahr,
                        ':leistung' => $leistung,
                        ':nenngeschwindigkeit' => $nenngeschwindigkeit,
                        ':kraftaufnehmer' => $kraftaufnehmer,
                        ':dms_nr' => $dms_nr,
                        ':tacho' => $tacho,
                        ':elektronik' => $elektronik,
                        ':material' => $material,
                        ':position' => $position,
                    ]);
                    $updFab->execute([
                        ':fab' => $fab,
                        ':type' => $type,
                        ':leistung' => $leistung,
                        ':nenngeschwindigkeit' => $nenngeschwindigkeit,
                        ':kraftaufnehmer' => $kraftaufnehmer,
                        ':dms_nr' => $dms_nr,
                        ':tacho' => $tacho,
                        ':elektronik' => $elektronik,
                        ':material' => $material,
                        ':position' => $position,
                    ]);
                }
            }

            // Meta am Auftrag aktualisieren
            $upd = $this->fsm->prepare('UPDATE jobs SET updated_at = NOW(), updated_by = :updated_by WHERE id = :job_id');
            $upd->execute([
                ':job_id' => $jobId,
                ':updated_by' => $updatedBy ?? $technicianId,
            ]);

            $this->fsm->commit();
            return true;
        } catch (\Throwable $e) {
            $this->fsm->rollBack();
            return false;
        }
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
     * Kalender: Jobs und Abwesenheiten aller Monteure in einem Datumsbereich.
     * Jobs erscheinen pro zugeordnetem Techniker (ein Auftrag mit 2 Monteuren = 2 Zeilen).
     *
     * @return array{jobs: list<array<string, mixed>>, absences: list<array<string, mixed>>, technicians: list<array<string, mixed>>}
     */
    public function getCalendarData(string $dateFrom, string $dateTo): array
    {
        $dateFrom = $this->normalizeDatetime($dateFrom);
        $dateTo = trim($dateTo);
        if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $dateTo)) {
            $dateTo .= ' 23:59:59';
        } elseif (!preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/', $dateTo)) {
            $dateTo .= ' 23:59:59';
        }

        // Farbe pro Techniker aus der Dispo (Spalte color oder farbe in users)
        $baseWhere = " role = 'monteur' AND active = 1 ORDER BY full_name, id";
        $technicians = null;
        foreach (["SELECT id, username, full_name, color FROM users WHERE {$baseWhere}", "SELECT id, username, full_name, farbe AS color FROM users WHERE {$baseWhere}"] as $techSql) {
            try {
                $technicians = $this->fsm->query($techSql)->fetchAll(PDO::FETCH_ASSOC);
                break;
            } catch (\Throwable $e) {
                continue;
            }
        }
        if ($technicians === null) {
            $techSql = "SELECT id, username, full_name FROM users WHERE {$baseWhere}";
            $technicians = $this->fsm->query($techSql)->fetchAll(PDO::FETCH_ASSOC);
            foreach ($technicians as &$t) {
                $t['color'] = null;
            }
            unset($t);
        }

        $jobSql = "SELECT j.id, j.job_number, j.job_type, j.start_datetime, j.end_datetime,
                   c.name AS customer_name, ja.city, ja.country, jt.technician_id
                   FROM jobs j
                   INNER JOIN job_technicians jt ON jt.job_id = j.id
                   INNER JOIN users u ON u.id = jt.technician_id AND u.role = 'monteur' AND u.active = 1
                   INNER JOIN customers c ON c.id = j.customer_id
                   LEFT JOIN job_addresses ja ON ja.job_id = j.id
                   WHERE j.start_datetime <= :date_to AND j.end_datetime >= :date_from
                   ORDER BY j.start_datetime ASC";
        $stmt = $this->fsm->prepare($jobSql);
        $stmt->execute([':date_from' => $dateFrom, ':date_to' => $dateTo]);
        $jobs = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $absSql = "SELECT id, technician_id, start_datetime, end_datetime, type FROM absences
                   WHERE start_datetime <= :date_to AND end_datetime >= :date_from
                   ORDER BY start_datetime ASC";
        $absStmt = $this->fsm->prepare($absSql);
        $absStmt->execute([':date_from' => $dateFrom, ':date_to' => $dateTo]);
        $absences = $absStmt->fetchAll(PDO::FETCH_ASSOC);

        return ['jobs' => $jobs, 'absences' => $absences, 'technicians' => $technicians];
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

    /**
     * Anlagenstamm-Daten für gegebene Fabrikationsnummern (für Zuordnung Leistungsdaten).
     * Reihenfolge wie übergebene Liste; fehlende Einträge mit leeren Type/Leistung/etc.
     *
     * @param list<string> $fabrikationsnummern
     * @return list<array{fabrikationsnummer: string, type: string, leistung: string, nenngeschwindigkeit: string, kraftaufnehmer: string, dms_nr: string, tacho: string, elektronik: string, material: string, position: string}>
     */
    public function getAnlagenstammByFabrikationsnummern(array $fabrikationsnummern): array
    {
        return $this->enrichFabFromAnlagenstamm($fabrikationsnummern);
    }

    /**
     * Fabrikationsnummern vom Auftrag parsen (jobs.fabrikationsnummern: Semikolon- oder Komma-getrennt).
     *
     * @return list<string>
     */
    private function parseFabrikationsnummernFromJob(string $raw): array
    {
        $raw = trim($raw);
        if ($raw === '') {
            return [];
        }
        $parts = preg_split('/\s*[;,]\s*/', $raw, -1, PREG_SPLIT_NO_EMPTY);
        $out = [];
        foreach ($parts as $p) {
            $p = trim($p);
            if ($p !== '') {
                $out[] = $p;
            }
        }
        return array_values(array_unique($out));
    }

    /**
     * Liste von Fabrikationsnummern mit Anlagenstamm-Daten anreichern.
     *
     * @param list<string> $fabrikationsnummern
     * @return list<array{fabrikationsnummer: string, type: string, leistung: string, nenngeschwindigkeit: string, kraftaufnehmer: string, dms_nr: string, tacho: string, elektronik: string, material: string, position: string}>
     */
    private function enrichFabFromAnlagenstamm(array $fabrikationsnummern): array
    {
        if ($fabrikationsnummern === []) {
            return [];
        }
        $placeholders = implode(',', array_fill(0, count($fabrikationsnummern), '?'));
        $sql = "SELECT fabrikationsnummer, type, leistung, nenngeschwindigkeit, kraftaufnehmer, dms_nr, tacho, elektronik, material, position FROM anlagenstamm WHERE fabrikationsnummer IN ($placeholders)";
        $stmt = $this->fsm->prepare($sql);
        $stmt->execute($fabrikationsnummern);
        $byFab = [];
        while (($r = $stmt->fetch(PDO::FETCH_ASSOC)) !== false) {
            $key = isset($r['fabrikationsnummer']) ? trim((string) $r['fabrikationsnummer']) : '';
            if ($key === '') {
                continue;
            }
            $byFab[$key] = [
                'fabrikationsnummer'   => $r['fabrikationsnummer'],
                'type'                 => $r['type'] ?? '',
                'leistung'             => $r['leistung'] ?? '',
                'nenngeschwindigkeit'  => $r['nenngeschwindigkeit'] ?? '',
                'kraftaufnehmer'       => $r['kraftaufnehmer'] ?? '',
                'dms_nr'               => $r['dms_nr'] ?? '',
                'tacho'                => $r['tacho'] ?? '',
                'elektronik'           => $r['elektronik'] ?? '',
                'material'             => $r['material'] ?? '',
                'position'             => $r['position'] ?? '',
            ];
        }
        $emptyRow = [
            'fabrikationsnummer' => '',
            'type'               => '',
            'leistung'           => '',
            'nenngeschwindigkeit'=> '',
            'kraftaufnehmer'     => '',
            'dms_nr'             => '',
            'tacho'              => '',
            'elektronik'         => '',
            'material'           => '',
            'position'           => '',
        ];
        $result = [];
        foreach ($fabrikationsnummern as $fab) {
            $fabTrim = trim((string) $fab);
            if ($fabTrim !== '' && isset($byFab[$fabTrim])) {
                $result[] = $byFab[$fabTrim];
            } else {
                $result[] = array_merge($emptyRow, ['fabrikationsnummer' => $fab]);
            }
        }
        return $result;
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
