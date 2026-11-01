# Security Policy

## Supported scope

This project is intended only for authorized CTF competitions, training labs,
and assets you own or are explicitly permitted to test.

## Do not report or commit

- Live platform usernames, passwords, DES keys, JWT/Cookie values
- API keys, SSH keys, cloud credentials, or `.deploy.env`
- Runtime databases, task workspaces, private evidence, or browser profiles
- Flags from competitions whose rules prohibit public disclosure

Before publishing, run:

```powershell
python release-tools/audit_public.py
```

The audit fails closed and redacts matched values.

## Reporting

For a security issue in this repository, use GitHub private vulnerability
reporting when available, or contact the repository owner without opening a
public issue that contains secrets.
