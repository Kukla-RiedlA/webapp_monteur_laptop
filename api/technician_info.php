<?php
declare(strict_types=1);

use App\Db;
use App\DispoRepository;

require_once __DIR__ . '/../bootstrap.php';

header('Content-Type: application/json; charset=utf-8');

$technicianId = getTechnicianId();
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

$technician = $repo->getTechnicianById($technicianId);
if ($technician === null) {
    http_response_code(404);
    echo json_encode(['ok' => false, 'error' => 'Monteur nicht gefunden.'], JSON_UNESCAPED_UNICODE);
    exit;
}

echo json_encode([
    'ok' => true,
    'id' => (int) $technician['id'],
    'username' => $technician['username'] ?? '',
    'full_name' => $technician['full_name'] ?? '',
], JSON_UNESCAPED_UNICODE);

function getTechnicianId(): ?int
{
    $id = $_GET['technician_id'] ?? $_SERVER['HTTP_X_TECHNICIAN_ID'] ?? null;
    if ($id !== null && $id !== '') {
        return (int) $id;
    }
    return null;
}
