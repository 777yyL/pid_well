#!/usr/bin/env bash
set -euo pipefail

# Run from the repository root during a scheduled maintenance window.
umask 077
if [[ ! -f .env ]]; then
    echo "Run this script from the deployment directory containing .env."
    exit 1
fi
backup_root="${1:-./backups}"
mkdir -p "${backup_root}"
backup_dir="$(mktemp -d "${backup_root}/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
docker compose config --quiet
docker compose stop app
trap 'docker compose start app >/dev/null' EXIT
docker compose exec -T db pg_dump -U tender -d tender -Fc > "${backup_dir}/database.dump"
docker compose run --rm --no-deps -T --entrypoint tar app -C /app/data -czf - . > "${backup_dir}/app-data.tgz"
cp .env "${backup_dir}/deployment.env"
docker compose images > "${backup_dir}/images.txt"
sha256sum "${backup_dir}/database.dump" "${backup_dir}/app-data.tgz" > "${backup_dir}/checksums.txt"
echo "Backup complete: ${backup_dir}. Store securely off this server."
