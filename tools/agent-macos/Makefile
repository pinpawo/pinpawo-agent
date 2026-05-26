.PHONY: generate open build build-agent archive clean

ARCHIVE_PATH ?= build/PinPawoAgent.xcarchive
XCODE_ARGS ?=
ARCHIVE_XCODE_ARGS ?= -allowProvisioningUpdates

# Requires: brew install xcodegen
generate:
	xcodegen generate

# Build local-agent dist first, then generate Xcode project and open
open: build-agent generate
	open PinPawoAgent.xcodeproj

build-agent:
	cd ../../services/local-agent && npm run build

build: build-agent generate
	xcodebuild \
		-project PinPawoAgent.xcodeproj \
		-scheme PinPawoAgent \
		-configuration Release \
		-derivedDataPath .build \
		$(XCODE_ARGS) \
		build

archive: build-agent generate
	xcodebuild \
		-project PinPawoAgent.xcodeproj \
		-scheme PinPawoAgent \
		-configuration Release \
		-derivedDataPath .build \
		-archivePath $(ARCHIVE_PATH) \
		$(ARCHIVE_XCODE_ARGS) \
		$(XCODE_ARGS) \
		archive

clean:
	rm -rf PinPawoAgent.xcodeproj .build
