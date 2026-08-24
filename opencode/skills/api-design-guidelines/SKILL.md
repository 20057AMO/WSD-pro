---
name: api-design-guidelines
description: REST API conventions — resource modeling, status-code discipline, error contracts, versioning, pagination. Use when creating or reviewing HTTP endpoints. Use PROACTIVELY before implementing any new route or changing an existing response shape.
---

# API Design Guidelines skill

Scope: HTTP API contracts. For query/database efficiency behind endpoints, pair with db-expert; this governs the CONTRACT clients see.

## Resource modeling
- Nouns plural for collections (`/projects`); verbs never in paths
- Nest only real ownership: `/projects/:slug/files` yes; chains beyond one level = smell
- Non-CRUD actions → POST sub-resources: `/projects/:slug/restart`

## Status codes — discipline table

| Code | Meaning | Example |
|---|---|---|
| 200 | success + body | GET/PUT result |
| 201 + Location | created | POST new resource |
| 204 | success, no body | DELETE |
| 400 | malformed input | validation failure |
| 401 | not authenticated | missing/bad token |
| 403 | authenticated, not allowed | non-owner access |
| 404 | unknown (or hidden) | other users' resources |
| 409 | conflict | duplicate slug/name |
| 429 | throttled | rate limit (+ Retry-After) |

NEVER 200-with-error-body.

## Error contract
One shape everywhere: `{"error":"<machine_code>","message":"<human text>","details"?:…}`.
Codes are stable enums clients branch on; messages change freely.

## Collections
Pagination explicit on EVERY list endpoint (`limit`/`offset` or cursor, defaults documented) · filtering/sorting conventions fixed once · bulk ops state atomicity (all-or-nothing vs per-item results).

## Evolution
Additive = compatible. Breaking (remove fields, change types/semantics) = new version path + deprecation window + migration notes. Consumers ignore unknown fields.

**Example**
```
POST /projects → 201 {id,slug,name} + Location: /api/projects/my-app
              → 409 {"error":"slug_taken","message":"Project name already exists"}
GET /projects?limit=20&offset=0&sort=-created → {items,total,limit,offset}
```

## Pitfalls
- ❌ Inventing a second error shape per endpoint ✅ The one contract
- ❌ 500 for validation failures ✅ 400 with machine code
- ❌ Silent pagination defaults ✅ Documented, echoed in response

Every inconsistency in your API becomes a special case in every client forever.
