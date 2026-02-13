<?php
declare(strict_types=1);

use App\Db;
use App\DispoRepository;

require_once __DIR__ . '/../bootstrap.php';

header('Content-Type: application/json; charset=utf-8');

$technicianId = getTechnicianId();
if ($technicianId === null) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'technician_id fehlt (Query, Header X-Technician-Id oder Body).'], JSON_UNESCAPED_UNICODE);
    exit;
}

$repo = new DispoRepository(Db::fsm());
if (!$repo->isTechnician($technicianId)) {
    http_response_code(403);
    echo json_encode(['ok' => false, 'error' => 'Kein gültiger Monteur.'], JSON_UNESCAPED_UNICODE);
    exit;
}

$dateFrom = $_GET['date_from'] ?? null;
$dateTo = $_GET['date_to'] ?? null;

$jobs = $repo->getJobsForTechnician($technicianId, $dateFrom ? (string) $dateFrom : null, $dateTo ? (string) $dateTo : null);
$technician = $repo->getTechnicianById($technicianId);

echo json_encode([
    'ok' => true,
    'technician_id' => $technicianId,
    'technician_full_name' => $technician !== null ? ($technician['full_name'] ?? null) : null,
    'technician_username' => $technician !== null ? ($technician['username'] ?? null) : null,
    'jobs' => $jobs,
], JSON_UNESCAPED_UNICODE);

function getTechnicianId(): ?int
{
    $id = $_GET['technician_id'] ?? $_SERVER['HTTP_X_TECHNICIAN_ID'] ?? null;
    if ($id !== null && $id !== '') {
        return (int) $id;
    }
    if ($_SERVER['REQUEST_METHOD'] === 'POST' || str_contains($_SERVER['CONTENT_TYPE'] ?? '', 'application/json')) {
        $body = file_get_contents('php://input');
        if (is_string($body)) {
            $data = json_decode($body, true);
            if (is_array($data) && isset($data['technician_id'])) {
                return (int) $data['technician_id'];
            }
        }
    }
    return null;
}
