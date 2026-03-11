<?php
declare(strict_types=1);

use App\Db;
use App\DispoRepository;

require_once __DIR__ . '/../bootstrap.php';

$COUNTRIES_BY_CODE = [];
$COUNTRIES_BY_NAME_LOWER = [];
$has_countries = false;
$countries_file = __DIR__ . '/../../dispo/config/countries.php';
if (is_file($countries_file)) {
    require_once $countries_file;
    $has_countries = !empty($COUNTRIES_BY_CODE) && !empty($COUNTRIES_BY_NAME_LOWER);
}

header('Content-Type: application/json; charset=utf-8');

$start = isset($_GET['start']) ? trim((string) $_GET['start']) : '';
$end   = isset($_GET['end'])   ? trim((string) $_GET['end'])   : '';
if ($start === '' || $end === '') {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Parameter start und end erforderlich (YYYY-MM-DD).'], JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    $startDate = new DateTime($start);
} catch (Exception $e) {
    $startDate = new DateTime();
}

$repo = new DispoRepository(Db::fsm());
$data = $repo->getCalendarData($start, $end);

// Anreicherung wie Dispo: country_code + local_time_hhmm (Lokale Uhrzeit)
foreach ($data['jobs'] as &$j) {
    $j['country_code'] = '';
    $j['local_time_hhmm'] = null;
    $raw = isset($j['country']) ? trim((string) $j['country']) : '';
    if ($raw !== '' && $has_countries) {
        $code = '';
        $upper = strtoupper($raw);
        if (isset($COUNTRIES_BY_CODE[$upper])) {
            $code = $upper;
        } else {
            $lowerName = mb_strtolower($raw, 'UTF-8');
            if (isset($COUNTRIES_BY_NAME_LOWER[$lowerName])) {
                $code = $COUNTRIES_BY_NAME_LOWER[$lowerName]['code'];
            }
        }
        $j['country_code'] = $code;
        if ($code !== '' && function_exists('country_local_time_hhmm')) {
            try {
                $j['local_time_hhmm'] = country_local_time_hhmm($code);
            } catch (Throwable $e) {
                $j['local_time_hhmm'] = null;
            }
        }
    }
}
unset($j);

echo json_encode([
    'ok' => true,
    'jobs' => $data['jobs'],
    'absences' => $data['absences'],
    'technicians' => $data['technicians'],
], JSON_UNESCAPED_UNICODE);
