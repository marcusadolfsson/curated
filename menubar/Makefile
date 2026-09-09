APP      := Curated
BUNDLE   := $(APP).app
CONFIG   := release
BIN      := .build/$(CONFIG)/$(APP)
INSTALL  := $(HOME)/Applications
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

.PHONY: all build app standalone sign copy run install install-standalone uninstall login-item clean

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
sign:
	@if [ -n '$(SIGN_ID)' ]; then \
	  echo "Signing as: $(SIGN_ID)"; \
	  find $(BUNDLE)/Contents/Resources -type f \( -name '*.node' -o -name '*.dylib' \) \
	    -exec codesign --force --options runtime --sign '$(SIGN_ID)' {} + 2>/dev/null; \
	  if [ -f $(BUNDLE)/Contents/Resources/node/bin/node ]; then \
	    codesign --force --options runtime --entitlements Resources/Curated.entitlements \
	      --sign '$(SIGN_ID)' $(BUNDLE)/Contents/Resources/node/bin/node; \
	  fi; \
	  codesign --force --options runtime --entitlements Resources/Curated.entitlements \
	    --sign '$(SIGN_ID)' $(BUNDLE); \
	else \
	  echo "No signing identity found. Signing ad-hoc, which means the app's"; \
	  echo "identity changes on every build. Fine to run, but macOS will treat"; \
	  echo "each build as a new app for login items and any permission grants."; \
	  codesign --force --sign - $(BUNDLE); \
	fi
	@echo "Built $(BUNDLE)"
	@codesign -d -r- $(BUNDLE) 2>&1 | sed -n 's/^designated => /Requirement: /p'

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

## Optional: start it at login. Whatever is installed - run `install` or
## `install-standalone` first. It used to depend on `install`, which meant
## asking for a login item quietly rebuilt the small app over the full one.
login-item:
	@mkdir -p $(HOME)/Library/LaunchAgents
	@printf '%s\n' \
	  '<?xml version="1.0" encoding="UTF-8"?>' \
	  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
	  '<plist version="1.0">' \
	  '<dict>' \
	  '  <key>Label</key><string>$(AGENT)</string>' \
	  '  <key>ProgramArguments</key>' \
	  '  <array><string>/usr/bin/open</string><string>-a</string><string>$(INSTALL)/$(BUNDLE)</string></array>' \
	  '  <key>RunAtLoad</key><true/>' \
	  '</dict>' \
	  '</plist>' > $(PLIST)
	-launchctl bootout gui/$$(id -u)/$(AGENT) 2>/dev/null
	launchctl bootstrap gui/$$(id -u) $(PLIST)
	@echo "Will start at login. Remove with: make uninstall"

uninstall:
	-launchctl bootout gui/$$(id -u)/$(AGENT) 2>/dev/null
	rm -f $(PLIST)
	rm -rf $(INSTALL)/$(BUNDLE)
	@echo "Removed"

clean:
	rm -rf .build $(BUNDLE)
