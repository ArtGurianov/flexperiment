# Installed Coolify 4.4.6 image-reference replay fixture

Captured read-only from the installed `coollabsio/coolify:4.4.6` container.
Upstream: https://github.com/coollabsio/coolify (Apache-2.0).
`image-pipeline.json` preserves unmodified source excerpts and SHA-256 hashes
of their full originating files. No application records, credentials or
provider configuration are included.

- Full `DockerImageParser` class.
- Literal Docker Image create API normalization block.
- Reflection-extracted deployment methods `deploy_dockerimage_buildpack`,
  `resolveDockerImageTag`, `generate_image_names`, `start_by_compose_file`.
- Literal service/network array from `generate_compose_file`.

The PHP harness executes that code. Request persistence, topology, logging,
non-image infrastructure and SSH are fixtures; no HTTP Coolify server or DB
is started. Commands are captured rather than executed by PHP. The registry
integration test feeds the real controller's create request through the
harness, writes the resulting Compose image field and executes the captured
Compose pull/up commands on an isolated CI Docker daemon. Its process is an
inert Node fixture; its image reference/image ID/RootFS/baked identity are
independently compared. This is source-path qualification, not a live Coolify
installation or a full restore/erasure admission proof.

## Important 4.4.6 distinction

At creation, a bare hexadecimal tag is recognized by DockerImageParser: the
API stores the name as `repository@sha256` and the tag as `<hash>`. The job then
combines those as `repository@sha256:<hash>`. Therefore the old API request was
not necessarily a mutable pull on this installed version. It still violated
the controller's repository-only read-back assumption and would fail before
configuration. Checking just the parser or just the deployment job misses
this difference.

The corrected controller requires the unambiguous persisted pair
`docker_registry_image_name=repository`,
`docker_registry_image_tag=sha256-<hash>` throughout create/configure/validate.
The deployment job resolves this as `repository@sha256:<hash>`. Ordinary tags
still resolve with `:` and cannot meet the controller's reference contract.
