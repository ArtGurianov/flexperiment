# ART-224: durable LAB private runtime

The owner authorized autonomous installation in the existing V2 canary. The
source/images remain pinned to application commit80a11bde; this configuration's
Git commit is a deployment-controller input, not a replacement application source.

Use the existing Coolify LAB application with raw Compose from a pinned Git
commit. Its service consumes the verified digest, uses only the existing private
canary network and the stable Commerce alias, and publishes no port or Traefik
route. Preserve the retired V1 router and four public403 guards. The existing
application has no persistent mounts or customer data to migrate.

Alternatives inspected: a native image destination would automatically connect
Coolify's proxy to the private network, while its production migration endpoint
is unavailable and cannot be bypassed. A one-time docker network attachment
would disappear on redeployment. Explicit raw Compose persists the intended
network without either operation. The owner delegated routine technical design
choices; no additional technical GO is needed.

Use the native image entrypoint and its small required nginx capabilities;
read-only rootfs, private tmpfs, no credentials, no host mounts, immutable digest.
PAYMENT_MODE stays disabled for LAB. Verify rendered Compose before deployment,
then container digest/RootFS/native identity, actual private readyz and static
refund contact. On uncertainty retain the recorded state, do not silently adopt
another image or reconnect Commerce to the shared network.

Receipt of mail is owner-attested in both directions; no headers/Message-ID are
claimed. The owner waived that extra evidence detail. No financial execution is
part of this acceptance. Existing three-role controller, DB lineage, credentials,
erasure and backup contracts remain independent and unchanged.
