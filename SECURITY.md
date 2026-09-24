# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately instead:

1. Go to the [Security tab](https://github.com/barisekara/reviewboxd/security) of this repository.
2. Click **Report a vulnerability** and describe what you found, how to reproduce it, and what an
   attacker could do with it.

Only the maintainer can see the report. You'll get a reply as soon as possible, and credit in
the fix if you'd like it.

## Scope

In scope: the code in this repository (the Node server, the front end, the Docker setup).

Out of scope: Letterboxd, TMDB, Cloudflare and other third-party services. Report issues with
those to their owners.

## Please don't

- Test against the live site at scale, or run automated scanners or load tests against it.
- Access or change share cards that aren't yours.

Run your own copy locally instead (see the README). It takes a minute and needs no dependencies.
