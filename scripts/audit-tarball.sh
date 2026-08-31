#!/usr/bin/env bash
# What a consumer actually receives.
#
# `files: ["dist"]` does not settle this. tsc compiles source comments into
# dist/*.js, and JSDoc on an export lands in dist/*.d.ts, where an editor shows
# it to the consumer on hover. This package shipped a private host name, four
# internal file paths and a write-up of a production incident that way before
# anyone thought to look inside the tarball.
#
# The checks are by SHAPE, not by a list of private names — a denylist would
# have to spell those names out in a public file to protect them, which is
# self-defeating, and it only ever catches what someone already thought of.
set -euo pipefail

pkg="${1:?usage: audit-tarball.sh <extracted-package-dir>}"

fail() { echo "REFUSING: $*"; exit 1; }

# 1. Everything a package needs to be usable and lawful. A missing LICENSE is
#    not cosmetic: published code with no licence is all rights reserved, so
#    nobody who installs it has permission to use it.
for f in README.md LICENSE package.json \
         dist/index.js dist/index.d.ts dist/register.js dist/register.d.ts; do
  test -f "$pkg/$f" || fail "$f is missing from the tarball"
done

# 2. Only these hosts may be named. An allowlist, so a link to anything private
#    fails by default rather than by having been predicted.
if grep -rhoE 'https?://[a-zA-Z0-9.-]+' "$pkg" \
   | sort -u \
   | grep -vE '^https?://(github\.com|getpino\.io|opentelemetry\.io|registry\.npmjs\.org|json\.schemastore\.org)$' \
   | grep . ; then
  fail "the tarball links to a host that is not on the allowlist above"
fi

# 3. Shapes that only ever come from somewhere else's repo: an issue reference,
#    a build-root absolute path, or a source tree the consumer does not have.
if grep -rnE '#[0-9]{3,}|/(repo|builds|home|Users)/|\b(apps|packages|infra|scripts|tests)/[a-z]' "$pkg"; then
  fail "the tarball names an issue, an absolute path, or a source tree a consumer does not have"
fi

echo "clean — the tarball names nothing it should not"
find "$pkg" -type f | sed "s|$pkg/|  |"
