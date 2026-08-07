# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## What this is

Hobbyist Studio is the web dashboard for Hobbyist, a self-hosted Postgres
platform that runs on one machine the user owns. Studio is served by the
Hobbyist daemon on the same box and reached over loopback or through a reverse
proxy.

## Primary user and job

One person, the owner and only operator of the machine. There are no teams, no
roles, no accounts, and no billing. They are a developer running side projects
on hardware they own: a five dollar VPS, a Mac Mini, or a dedicated server with
16 to 32 GB of RAM.

Two distinct jobs, at different moments:

1. **Manage the fleet.** Create a project, see what exists, see what is awake,
   grab a connection string, put something to sleep or wake it.
2. **Work inside one database.** Browse tables, run SQL, read the schema.

## The mechanism that makes it different

**Everything sleeps when unused and wakes on demand.** A database with nothing
connected is stopped: zero RAM, disk only. A connection or a query starts it and
serves the request, measured at roughly 300ms end to end on developer hardware.
Nothing else self-hostable does this. Self-hosted Supabase never sleeps. Xata's
open-source scale-to-zero cannot wake a hibernated cluster.

Sleep is the product's identity, not a status detail. It is why many projects
fit on one small box.

## Structure

- **Project** is the container and the top-level unit. The user picks a project,
  then works inside it.
- **Services** are scoped to a project. Today the only service kind is a
  Postgres database. Compute and object storage arrive in later phases and get
  their own interfaces inside the same project.
- Services in a project reference each other by configuration, for example a
  compute service using a database's connection string. Formal bindings are a
  future idea, not a current capability.

## Terminology

- **Sleeping** and **awake**, not paused, stopped, idle or hibernated. One pair
  of words everywhere, including CLI output.
- **Project**, **database**, **connection string**.
- Default idle threshold before sleeping is 300 seconds.

## Durable constraints

- **Local first and offline capable.** Runs on a box that may have no internet.
  No CDN, no external fonts, no analytics, nothing that phones home.
- **Studio holds no database credentials and opens no database connections.**
  Every query goes through the daemon API, which is what lets a query against a
  sleeping database wake it.
- **One operator credential**, set only by a command run on the box. No signup,
  no password reset, no account recovery.
- **No metering or billing surface**, ever. The product is free and always will
  be. Where a hosted product shows plan quota, the honest local analogue is the
  machine's own capacity: RAM headroom, databases awake, disk used.
- **Never advertise what does not exist.** The project's own rule is that a
  reader must never execute an aspiration, so unbuilt capabilities do not appear
  as disabled navigation.
- Capacity reality, measured: an awake database is about 72 MiB of RAM, a
  sleeping one is 0, and a fresh data directory is about 46 MB of disk.

## Voice

Plain, lowercase where the CLI is lowercase, no exclamation, no emoji, no
em-dashes. Errors name the problem and the exact command that fixes it. The
tagline is "your stack, your box, their convenience."

## Open

- How many projects a typical install holds is not yet confirmed. The current
  design assumes a handful rather than dozens.
