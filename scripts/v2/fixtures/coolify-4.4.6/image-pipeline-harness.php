<?php
// Test-only: execute exact installed API normalization and deployment methods.
// No Laravel database, Coolify HTTP calls, SSH, Docker socket or production IO.
// Only remote command execution / non-image infrastructure is captured/stubbed.
$fixture = json_decode(file_get_contents(__DIR__.'/image-pipeline.json'), true, flags: JSON_THROW_ON_ERROR);
$input = json_decode(stream_get_contents(STDIN), true, flags: JSON_THROW_ON_ERROR);
eval(substr($fixture['parser'], 5));
class_alias('App\\Services\\DockerImageParser', 'DockerImageParser');
class TestString {
    public function __construct(private string $value) {}
    public function startsWith(string $prefix): bool { return str_starts_with($this->value, $prefix); }
    public function after(string $prefix): self { return new self(substr($this->value, strpos($this->value, $prefix)+strlen($prefix))); }
    public function isNotEmpty(): bool { return $this->value !== ''; }
    public function __toString(): string { return $this->value; }
}
function str($value): TestString { return new TestString($value ?? ''); }
function executeInDocker($unused, $command) { return $command; }
define('RESTART_MODE', 'no');
class TestRequest {
    public function __construct(public array $fields) {}
    public function __get($key) { return $this->fields[$key] ?? null; }
    public function offsetSet($key, $value) { $this->fields[$key] = $value; }
}
class TestQueue { public function addLogEntry($unused) {} }
class TestDestination {
    public string $network = 'art337-test-network';
    public function proxyConnectCommand() { return 'true'; }
}
$request = new TestRequest($input['body']);
// Execute the installed API's literal normalization statements, not a Python
// approximation of the digest/tag parser or request persistence.
eval($fixture['apiNormalization']);
$methods = implode("\n", $fixture['methods']);
$compose = $fixture['composeArray'];
$stubs = <<<'STUBS'
public $application; public $application_deployment_queue; public $server; public $destination;
private $dockerImage; private $dockerImageTag; private $dockerImagePreviewTag = null;
private $production_image_name; private $build_image_name;
private $pull_request_id = 0; private $rollback = false; private $commit = '';
private $deployment_uuid = 'art337-test'; private $workdir = '/proof';
private $configuration_dir = '/proof'; private $coolify_variables = '';
private $container_name = 'art337-fixture'; public $commands = []; public $compose;
private function prepare_builder_image() {}
private function save_runtime_environment_variables() {}
private function write_missing_content_files() {}
private function rolling_update() { $this->start_by_compose_file(); }
private function execute_remote_command(...$commands) { foreach($commands as $row) $this->commands[] = $row[0]; }
public function execute($fields, $scenario = []) {
    $this->container_name = $scenario["containerName"] ?? "art337-fixture";
    $this->workdir = $scenario["workdir"] ?? "/proof";
    $this->configuration_dir = $this->workdir;
    $fields["uuid"] = $scenario["uuid"] ?? "art337-fixture";
    $this->application = (object) array_merge(['build_pack'=>'dockerimage', 'dockerfile'=>null,
        'uuid'=>'art337-fixture', 'limits_memory'=>'0', 'limits_memory_swap'=>'0',
        'limits_memory_swappiness'=>60,'limits_memory_reservation'=>'0',
        'limits_cpus'=>0,'limits_cpu_shares'=>1024], $fields);
    $this->application_deployment_queue = new TestQueue;
    $this->server = (object)['name'=>'isolated']; $this->destination = new TestDestination;
    $this->destination->network = $scenario["network"] ?? "art337-test-network";
    $this->deploy_dockerimage_buildpack();
    return ['productionImage'=>$this->production_image_name, 'compose'=>$this->compose, 'commands'=>$this->commands];
}
STUBS;
// The literal upstream service image assignment and the actual upstream
// start_by_compose_file method supply Compose and its pull/up commands.
$generate = 'private function generate_compose_file() { $ports=[]; $custom_network_aliases=[]; '.$compose.' $this->compose=$docker_compose; }';
eval('class ImageJobFixture { '.$stubs.$generate.$methods.' }');
$job = new ImageJobFixture;
$result = $job->execute($request->fields, $input["scenario"] ?? []);
echo json_encode(['version'=>$fixture['version'], 'sourceHashes'=>$fixture['sourceHashes'],
    'persisted'=>$request->fields, 'job'=>$result], JSON_THROW_ON_ERROR|JSON_UNESCAPED_SLASHES);
