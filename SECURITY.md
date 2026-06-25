# Security Policy

## Reporting a Vulnerability

Homelander handles IS24 credentials, 2captcha API keys, and personal contact data locally. If you discover a security issue, please **do not** open a public issue.

Email: **kolausf@gmail.com**

Expected response: within 48 hours. Please include:

- Description of the vulnerability
- Steps to reproduce
- Affected version(s)

## Scope

- Credential storage (config.json, OS keychain)
- Support bundle data leakage
- Browser automation surface (Chromium sandboxing)
- Dependencies with known CVEs

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 1.4.x   | :white_check_mark: |
| 1.3.x   | :white_check_mark: |
| < 1.3   | :x:                |
