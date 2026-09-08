APP      := CuratedBar
BUNDLE   := $(APP).app
CONFIG   := release
BIN      := .build/$(CONFIG)/$(APP)
INSTALL  := $(HOME)/Applications
AGENT    := com.curated.menubar
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

.PHONY: all build app run install uninstall login-item clean

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
	@if [ -n '$(SIGN_ID)' ]; then \
	  echo "Signing as: $(SIGN_ID)"; \
	  codesign --force --options runtime --timestamp --sign '$(SIGN_ID)' $(BUNDLE) 2>/dev/null \
	    || codesign --force --options runtime --sign '$(SIGN_ID)' $(BUNDLE); \
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

install: app
	mkdir -p $(INSTALL)
	rm -rf $(INSTALL)/$(BUNDLE)
	cp -R $(BUNDLE) $(INSTALL)/
	@echo "Installed to $(INSTALL)/$(BUNDLE)"

## Optional: start it at login, the same way the app and tunnel already do.
login-item: install
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
