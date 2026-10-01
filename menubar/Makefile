APP      := Curated
BUNDLE   := $(APP).app
CONFIG   := release
INSTALL  := /Applications
AGENT    := com.curated.app
PLIST    := $(HOME)/Library/LaunchAgents/$(AGENT).plist

## Signing identity. This matters more than it looks for something that starts
## at login: an ad-hoc signature's designated requirement is a bare cdhash of
## the binary, so every rebuild is a different identity as far as macOS is
## concerned. A real certificate gives a requirement built from the bundle id
## and the certificate instead, which survives a rebuild untouched.
##
## Developer ID is preferred, an Apple Development certificate will do for a
## machine signing its own app, and ad-hoc is the fallback when there is
## neither. Override with: make app SIGN_ID="Developer ID Application: ..."
SIGN_ID ?= $(shell security find-identity -v -p codesigning 2>/dev/null | \
             awk -F'"' '/Developer ID Application/{print $$2; exit}')
ifeq ($(strip $(SIGN_ID)),)
SIGN_ID := $(shell security find-identity -v -p codesigning 2>/dev/null | \
             awk -F'"' '/Apple Development/{print $$2; exit}')
endif

## A secure timestamp is what notarization asks for, and it costs a round trip
## to Apple per signature, so only a Developer ID build pays for it.
TIMESTAMP := $(if $(findstring Developer ID Application,$(SIGN_ID)),--timestamp,)

## Apple Silicon only. The server carries native code - Node, better-sqlite3,
## sharp, the Agent SDK's claude - built for the machine that runs the build,
## and an Intel build would mean a second copy of every piece of it.
BIN      := .build/$(CONFIG)/$(APP)

## Releases. Notarization credentials come from a notarytool keychain profile,
## created once with
##   xcrun notarytool store-credentials curated --apple-id <id> --team-id ZP8TR4ZYDR --password <app-specific>
## CI passes Apple ID arguments instead (.github/workflows/menubar-release.yml).
## No secret lives here.
NOTARY_PROFILE ?= curated
NOTARY_AUTH ?= --keychain-profile "$(NOTARY_PROFILE)"
DIST     := dist
DIST_ZIP := $(DIST)/Curated.zip
DMG      := $(DIST)/Curated.dmg

.PHONY: all build app standalone sign copy run install install-standalone uninstall clean dmg notarize smoke

all: app

build:
	swift build -c $(CONFIG)

## Assemble a real .app bundle. A menu bar app needs one: LSUIElement lives in
## Info.plist, and a bare executable gets a Dock icon and no bundle identifier.
app: build
	rm -rf $(BUNDLE)
	mkdir -p $(BUNDLE)/Contents/MacOS $(BUNDLE)/Contents/Resources
	cp Resources/Info.plist $(BUNDLE)/Contents/Info.plist
	cp $(BIN) $(BUNDLE)/Contents/MacOS/$(APP)
	$(MAKE) sign

## The whole thing: menu bar app, Node, and the server it runs.
##
## `make app` on its own still builds the small version that watches a server
## somebody else is running - that is what to build while working on the menu.
## This is the one you install on a Mac that has nothing.
##
## Signing is inside-out and has to be: codesign seals a bundle by hashing what
## is in it, so anything added afterwards invalidates the signature, and nested
## code has to carry its own before the outer seal is made.
standalone: build
	rm -rf $(BUNDLE)
	mkdir -p $(BUNDLE)/Contents/MacOS $(BUNDLE)/Contents/Resources
	cp Resources/Info.plist $(BUNDLE)/Contents/Info.plist
	cp $(BIN) $(BUNDLE)/Contents/MacOS/$(APP)
	@echo "Fetching Node..."
	@NODE_DIR=$$(cd .. && ./scripts/fetch-node.sh) && \
	  mkdir -p $(BUNDLE)/Contents/Resources/node/bin && \
	  cp "$$NODE_DIR/bin/node" $(BUNDLE)/Contents/Resources/node/bin/node
	@echo "Building the server..."
	cd .. && npm run build >/dev/null && ./scripts/bundle.sh
	cp -R ../dist/server $(BUNDLE)/Contents/Resources/server
	$(MAKE) sign
	@du -sh $(BUNDLE)

## Inside-out: nested code first, the bundle last, because codesign seals a
## bundle by hashing what is in it and anything added afterwards breaks it.
##
## The nested `node` gets the entitlements too, not just the outer app. It is
## the process that runs V8 and dlopens better-sqlite3, and the hardened runtime
## reads entitlements from the binary being executed rather than from whatever
## bundle it happens to sit in. Without them node dies on the first native
## require with SIGTRAP and prints nothing at all, which is a memorable
## afternoon.
## The Agent SDK's claude binaries are left as they come: Anthropic signs them
## with its own Developer ID, hardened runtime and a timestamp, which is what
## notarization asks of nested code, and re-signing them would only replace a
## signature that already vouches for them.
sign:
	@set -e; if [ -n '$(SIGN_ID)' ]; then \
	  echo "Signing as: $(SIGN_ID)"; \
	  find $(BUNDLE)/Contents/Resources -type f \( -name '*.node' -o -name '*.dylib' \) \
	    -exec codesign --force --options runtime $(TIMESTAMP) --sign '$(SIGN_ID)' {} + ; \
	  if [ -f $(BUNDLE)/Contents/Resources/node/bin/node ]; then \
	    codesign --force --options runtime $(TIMESTAMP) --entitlements Resources/Curated.entitlements \
	      --sign '$(SIGN_ID)' $(BUNDLE)/Contents/Resources/node/bin/node; \
	  fi; \
	  codesign --force --options runtime $(TIMESTAMP) --entitlements Resources/Curated.entitlements \
	    --sign '$(SIGN_ID)' $(BUNDLE); \
	  codesign --verify --strict --deep $(BUNDLE); \
	else \
	  echo "No signing identity found. Signing ad-hoc, which means the app's"; \
	  echo "identity changes on every build. Fine to run, but macOS will treat"; \
	  echo "each build as a new app for login items and any permission grants."; \
	  codesign --force --sign - $(BUNDLE); \
	fi
	@echo "Built $(BUNDLE)"
	@codesign -d -r- $(BUNDLE) 2>&1 | sed -n 's/^designated => /Requirement: /p'

## A drag-to-Applications disk image of whatever $(BUNDLE) was last built.
dmg:
	@test -d $(BUNDLE) || { echo "Build the app first (make standalone)"; exit 1; }
	rm -rf $(DIST)/dmg-root $(DMG)
	mkdir -p $(DIST)/dmg-root
	cp -R $(BUNDLE) $(DIST)/dmg-root/
	ln -s /Applications $(DIST)/dmg-root/Applications
	hdiutil create -volname "$(APP)" -srcfolder $(DIST)/dmg-root -fs HFS+ -format UDZO -ov $(DMG)
	rm -rf $(DIST)/dmg-root
	codesign --force $(TIMESTAMP) --sign '$(SIGN_ID)' $(DMG)
	@echo "Built $(DMG) ($$(du -sh $(DMG) | cut -f1))"

## The release: Developer ID signed, notarized, stapled - the app
## first, so its ticket is stapled inside the image, then the image around it,
## so it installs cleanly offline.
##
## The identity is checked before anything is built, because the build takes
## minutes and an Apple Development signature would only fail at the end.
notarize:
	@case '$(SIGN_ID)' in "Developer ID Application"*) ;; \
	  *) echo "Notarization needs a Developer ID Application certificate; signing identity is: '$(SIGN_ID)'"; exit 1;; esac
	@xcrun notarytool history $(NOTARY_AUTH) >/dev/null 2>&1 || { \
	  echo "Notarization credentials not usable. Create the profile once with:"; \
	  echo "  xcrun notarytool store-credentials $(NOTARY_PROFILE) --apple-id <APPLE_ID> --team-id ZP8TR4ZYDR --password <app-specific password>"; \
	  exit 1; }
	$(MAKE) standalone
	$(MAKE) smoke
	mkdir -p $(DIST)
	rm -f $(DIST_ZIP)
	ditto -c -k --keepParent $(BUNDLE) $(DIST_ZIP)
	xcrun notarytool submit $(DIST_ZIP) $(NOTARY_AUTH) --wait
	xcrun stapler staple $(BUNDLE)
	rm -f $(DIST_ZIP)
	$(MAKE) dmg
	xcrun notarytool submit $(DMG) $(NOTARY_AUTH) --wait
	xcrun stapler staple $(DMG)
	xcrun stapler validate $(DMG)
	spctl --assess --type open --context context:primary-signature --verbose=2 $(DMG)
	spctl --assess --type execute --verbose=2 $(BUNDLE)
	@echo "Notarized: $(DMG)"

## Boots the server exactly as it sits in the built app - its own node, its own
## modules - from a temporary directory with a throwaway database.
smoke:
	@test -d $(BUNDLE)/Contents/Resources/server || { echo "Build the app first (make standalone)"; exit 1; }
	cd .. && NODE_BIN=$(CURDIR)/$(BUNDLE)/Contents/Resources/node/bin/node \
	  ./scripts/smoke.sh $(CURDIR)/$(BUNDLE)/Contents/Resources/server

run: app
	open $(BUNDLE)

install: app copy

## The whole app - menu bar, Node and the server - onto this Mac.
##
## Separate target rather than a flag, because `install` depends on `app` and
## would otherwise rebuild the small bundle straight over the standalone one.
install-standalone: standalone copy

copy:
	mkdir -p $(INSTALL)
	rm -rf $(INSTALL)/$(BUNDLE)
	cp -R $(BUNDLE) $(INSTALL)/
	@echo "Installed to $(INSTALL)/$(BUNDLE) ($$(du -sh $(INSTALL)/$(BUNDLE) | cut -f1))"
	@echo "Already running? It will not be replaced until you quit it:"
	@echo "  pkill -f '$(APP).app/Contents/MacOS/$(APP)'"
	@echo "Open it once and it offers to start at login; the menu has a toggle."

## Removes the app, and the LaunchAgent plist if an older build left one.
##
## The login item itself belongs to macOS now - the app registers it with
## SMAppService and macOS drops it when the bundle goes.
uninstall:
	-launchctl bootout gui/$$(id -u)/$(AGENT) 2>/dev/null
	rm -f $(PLIST)
	rm -rf $(INSTALL)/$(BUNDLE)
	@echo "Removed. Check System Settings > General > Login Items if an entry lingers."

clean:
	rm -rf .build $(BUNDLE) $(DIST)
