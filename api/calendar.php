<?php
declare(strict_types=1);

use App\Db;
use App\DispoRepository;

require_once __DIR__ . '/../bootstrap.php';

header('Content-Type: application/json; charset=utf-8');

$start = isset($_GET['start']) ? trim((string) $_GET['start']) : '';
$end   = isset($_GET['end'])   ? trim((string) $_GET['end'])   : '';
if ($start === '' || $end === '') {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Parameter start und end erforderlich (YYYY-MM-DD).'], JSON_UNESCAPED_UNICODE);
    exit;
}

$repo = new DispoRepository(Db::fsm());
$data = $repo->getCalendarData($start, $end);

echo json_encode([
    'ok' => true,
    'jobs' => $data['jobs'],
    'absences' => $data['absences'],
    'technicians' => $data['technicians'],
], JSON_UNESCAPED_UNICODE);
