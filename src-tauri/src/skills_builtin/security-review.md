---
name: security-review
description: "Audit code for security vulnerabilities (injection, auth, secrets, unsafe input handling, dependencies) and report concrete, exploitable findings."
---
# Method
1. Map the attack surface: entry points (HTTP routes, CLI args, file/IPC input, webhooks), where data is stored, who is trusted.
2. Follow untrusted input from each entry point to where it is used.
3. Check each class below; report only issues with a plausible exploit path.

# Checklist
- Injection: SQL/NoSQL built with string concatenation, shell commands with user input, template/HTML injection (XSS), eval / dynamic imports, LDAP/XPath.
- AuthN/AuthZ: missing checks on endpoints, IDOR (object ids not checked against the user), privilege escalation, weak session/JWT handling (no expiry, `alg: none`, secret in code).
- Secrets: keys, tokens, passwords in the repo, logs or client bundles; `.env` committed.
- Files and paths: path traversal (`../`), unrestricted uploads, zip slip, symlinks.
- Web: CSRF on state-changing requests, permissive CORS with credentials, missing security headers, open redirects, SSRF via user-supplied URLs.
- Crypto: home-made crypto, MD5/SHA1 for passwords (use argon2/bcrypt/scrypt), non-random tokens, disabled TLS verification.
- Data exposure: stack traces or internal errors returned to clients, over-broad API responses, PII in logs.
- Dependencies: run the ecosystem's audit (`npm audit`, `pip-audit`, `cargo audit`, `dotnet list package --vulnerable`) when available.

# Report
Per finding: severity (critical/high/medium/low), location, the exploit scenario in 1–2 sentences, and the fix. Say explicitly what you did not check.
