<?php
declare(strict_types=1);

use App\Db;
use App\DispoRepository;

require_once __DIR__ . '/../bootstrap.php';

header('Content-Type: application/json; charset=utf-8');

$technicianId = getTechnicianIdFromRequest();
if ($technicianId === null) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'technician_id fehlt (Query oder Header X-Technician-Id).'], JSON_UNESCAPED_UNICODE);
    exit;
}

$repo = new DispoRepository(Db::fsm());
if (!$repo->isTechnician($technicianId)) {
    http_response_code(403);
    echo json_encode(['ok' => false, 'error' => 'Kein gültiger Monteur.'], JSON_UNESCAPED_UNICODE);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $jobId = isset($_GET['id']) ? (int) $_GET['id'] : null;
    if ($jobId <= 0) {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'Parameter id fehlt oder ungültig.'], JSON_UNESCAPED_UNICODE);
        exit;
    }
    $job = $repo->getJobByIdForTechnician($jobId, $technicianId);
    if ($job === null) {
        http_response_code(404);
        echo json_encode(['ok' => false, 'error' => 'Auftrag nicht gefunden oder nicht zugeordnet.'], JSON_UNESCAPED_UNICODE);
        exit;
    }
    echo json_encode(['ok' => true, 'job' => $job], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($method === 'PATCH' || $method === 'POST') {
    $body = (string) file_get_contents('php://input');
    $data = $body !== '' ? json_decode($body, true) : null;
    if (!is_array($data) || empty($data['job_id'])) {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'Body: job_id erforderlich.'], JSON_UNESCAPED_UNICODE);
        exit;
    }
    $jobId = (int) $data['job_id'];

    if (isset($data['status']) && is_string($data['status'])) {
        $ok = $repo->updateJobStatus($jobId, $technicianId, trim($data['status']));
        if (!$ok) {
            http_response_code(400);
            echo json_encode(['ok' => false, 'error' => 'Status-Update fehlgeschlagen (ungültiger Status oder keine Berechtigung).'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        echo json_encode(['ok' => true, 'updated' => 'status'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if (array_key_exists('description', $data)) {
        $ok = $repo->updateJobDescription($jobId, $technicianId, is_string($data['description']) ? $data['description'] : '');
        if (!$ok) {
            http_response_code(400);
            echo json_encode(['ok' => false, 'error' => 'Beschreibungs-Update fehlgeschlagen.'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        echo json_encode(['ok' => true, 'updated' => 'description'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Body: status oder description erforderlich.'], JSON_UNESCAPED_UNICODE);
    exit;
}

http_response_code(405);
echo json_encode(['ok' => false, 'error' => 'Method Not Allowed.'], JSON_UNESCAPED_UNICODE);

function getTechnicianIdFromRequest(): ?int
{
    $id = $_GET['technician_id'] ?? $_SERVER['HTTP_X_TECHNICIAN_ID'] ?? null;
    if ($id !== null && $id !== '') {
        return (int) $id;
    }
    return null;
}
