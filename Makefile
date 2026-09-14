# Thin wrappers over the docker compose incantations these tasks need. Nothing
# here deploys: that means touching the Pi and is asked for each time (CLAUDE.md).
.PHONY: typecheck test web-build web summarize logs status

# The root program and the browser half are two separate tsc runs - the root
# tsconfig deliberately excludes packages/web/client, and vite build does not
# type-check at all.
typecheck:
	docker compose run --rm app npx tsc --noEmit
	docker compose run --rm app npx tsc -p packages/web --noEmit

test:
	docker compose run --rm app npm test

# Rebuilds the dashboard bundle into packages/web/dist. --no-workspaces keeps
# node_modules inside packages/web, which is bind-mounted, so it persists on
# the host and only the first run pays for the install.
#
# `npm run build`, never `npx vite build`: packages/web is a workspace member,
# so npx resolves against the workspace root's node_modules, does not find vite
# there, and silently downloads whatever is latest on the registry instead -
# it built with vite 8 while package.json pinned ^6.0.7. `npm run` resolves
# from the package's own .bin, which is the pinned one.
web-build:
	docker compose run --rm app sh -c "cd packages/web && npm install --no-workspaces && npm run build"

# Never `up --build` for this one: web shares the control loop's image, and
# rebuilding that image is another Anker cloud login.
web: web-build
	docker compose up -d web

# Rolls completed days into data/summaries/YYYY-MM.json and deletes raw days
# that are both summarised and past the retention window. Safe to run against
# the live loop - the day currently being written is never read or deleted -
# and safe to run twice. The `scheduler` compose service runs it nightly;
# this is the manual form.
summarize:
	docker compose run --rm app soltrk summarize

logs:
	docker compose logs --tail 40 -f soltrk

status:
	docker compose exec soltrk soltrk status
