<?php
declare(strict_types=1);

use App\Db;
use App\DispoRepository;

require_once __DIR__ . '/../bootstrap.php';

header('Content-Type: application/json; charset=utf-8');

$technicianId = getTechnicianId();
if ($technicianId === null) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'technician_id fehlt.'], JSON_UNESCAPED_UNICODE);
    exit;
}

$repo = new DispoRepository(Db::fsm());
if (!$repo->isTechnician($technicianId)) {
    http_response_code(403);
    echo json_encode(['ok' => false, 'error' => 'Kein gültiger Monteur.'], JSON_UNESCAPED_UNICODE);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'];
$body = file_get_contents('php://input');
$data = is_string($body) && $body !== '' ? json_decode($body, true) : [];

if ($method === 'POST') {
    $start = $data['start_datetime'] ?? $data['start'] ?? $data['date_from'] ?? '';
    $end = $data['end_datetime'] ?? $data['end'] ?? $data['date_to'] ?? '';
    $type = $data['type'] ?? null;
    if ($start === '' || $end === '') {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'start_datetime und end_datetime (oder start/end, date_from/date_to) erforderlich.'], JSON_UNESCAPED_UNICODE);
        exit;
    }
    $id = $repo->createAbsence($technicianId, $start, $end, $type !== null ? (string) $type : null);
    echo json_encode(['ok' => true, 'id' => $id], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($method === 'PATCH' || $method === 'PUT') {
    $id = isset($data['id']) ? (int) $data['id'] : (isset($_GET['id']) ? (int) $_GET['id'] : 0);
    $start = $data['start_datetime'] ?? $data['start'] ?? $data['date_from'] ?? '';
    $end = $data['end_datetime'] ?? $data['end'] ?? $data['date_to'] ?? '';
    $type = $data['type'] ?? null;
    if ($id <= 0 || $start === '' || $end === '') {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'id, start_datetime und end_datetime erforderlich.'], JSON_UNESCAPED_UNICODE);
        exit;
    }
    $ok = $repo->updateAbsence($id, $technicianId, $start, $end, $type !== null ? (string) $type : null);
    if (!$ok) {
        http_response_code(404);
        echo json_encode(['ok' => false, 'error' => 'Abwesenheit nicht gefunden oder keine Berechtigung.'], JSON_UNESCAPED_UNICODE);
        exit;
    }
    echo json_encode(['ok' => true], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($method === 'DELETE') {
    $id = isset($_GET['id']) ? (int) $_GET['id'] : (isset($data['id']) ? (int) $data['id'] : 0);
    if ($id <= 0) {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'Parameter id fehlt.'], JSON_UNESCAPED_UNICODE);
        exit;
    }
    $ok = $repo->deleteAbsence($id, $technicianId);
    if (!$ok) {
        http_response_code(404);
        echo json_encode(['ok' => false, 'error' => 'Abwesenheit nicht gefunden oder keine Berechtigung.'], JSON_UNESCAPED_UNICODE);
        exit;
    }
    echo json_encode(['ok' => true], JSON_UNESCAPED_UNICODE);
    exit;
}

http_response_code(405);
echo json_encode(['ok' => false, 'error' => 'Method Not Allowed.'], JSON_UNESCAPED_UNICODE);

function getTechnicianId(): ?int
{
    $id = $_GET['technician_id'] ?? $_SERVER['HTTP_X_TECHNICIAN_ID'] ?? null;
    if ($id !== null && $id !== '') {
        return (int) $id;
    }
    return null;
}
