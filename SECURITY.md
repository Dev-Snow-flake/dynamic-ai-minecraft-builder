# Security policy

Please report vulnerabilities privately through GitHub Security Advisories. Do not include API keys, bridge secrets, administrator passwords, world diffs, or player data in a public issue.

Supported releases are the latest tagged release only. Before reporting, reproduce with the default fail-closed policy (`allow-world-writes: false`) and the current Paper build when possible.

The web control plane must remain behind HTTPS. OpenAI keys belong only in the authenticated server-side key store or an `OPENAI_API_KEY` environment variable; never put them in browser code, Git history, screenshots, or plugin defaults.
