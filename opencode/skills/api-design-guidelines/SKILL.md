---
name: api-design-guidelines
description: REST API conventions — resource modeling, status-code discipline, error contract, versioning, pagination and filtering
---

# API Design Guidelines skill

Use when creating or reviewing HTTP APIs.

## Resource modeling
- Nouns plural for collections (`/projects`), verbs never in paths
- Nest only real ownership: `/projects/:slug/files` yes; deep chains beyond one level are a smell
- Actions that don't map to CRUD become sub-resources or POST commands: `/projects/:slug/restart`

## Status codes — the discipline table
| Code | Meaning | Example |
|---|---|---|
| 200 | success with body | GET/PUT result |
| 201 + Location | created | POST new resource |
| 204 | success, no body | DELETE |
| 400 | malformed input | validation failure |
| 401 | not authenticated | missing/bad token |
| 403 | authenticated, not allowed | non-owner access |
| 404 | unknown (or hidden) | other users' resources |
| 409 | conflict | duplicate slug/name |
| 429 | throttled | rate limit hit (+ Retry-After) |
Never 200-with-error-body.

## Error contract
One shape everywhere: `{"error": "<machine_code>", "message": "<human text>", "details"?: …}`.
Machine codes are stable enum values clients branch on; messages may change freely.

## Collections
- Pagination explicit on every list endpoint (`limit`/`offset` or cursor) with defaults documented
- Filtering/sorting conventions fixed once and reused
- Bulk operations state atomicity: all-or-nothing vs per-item results

## Versioning & evolution
- Additive = compatible. Breaking (removing fields, changing types/semantics) = new version path + deprecation window + migration notes
- Unknown fields ignored by consumers, preserved by proxies

## Security defaults
Auth on everything not explicitly public · validation at entry · rate limits on auth/expensive routes · no secrets in URLs.
