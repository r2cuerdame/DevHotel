import { createHash } from 'node:crypto'

/**
 * The managed Android emulator preview image, built by DevHotel inside its own
 * managed Linux runtime from a Dockerfile this repository carries.
 *
 * ## Why this is built rather than pulled
 *
 * #108 removed `budtmo/docker-android` from the managed execution path and
 * replaced it with a DevHotel-owned image published to GHCR. That traded one
 * dependency for a worse one for #111's purposes: the published package is
 * private, so a pull by digest needs a GitHub credential. #111's Android claim
 * is that a *clean* Windows 11 machine builds, installs, launches and previews
 * Android with no Host prerequisites, and a clean machine has no such
 * credential. The pull therefore failed at the first step, for a reason that
 * had nothing to do with Android.
 *
 * Building the image in the runtime removes the registry from the claim
 * entirely. What crosses the network is the Ubuntu base layer, pinned by
 * digest on Docker Hub and anonymously pullable, and Ubuntu's own apt pool —
 * the same bytes the GHCR image was itself built from. No DevHotel-published
 * artifact has to exist for a clean machine to reach a working emulator
 * preview, which is what makes the row provable rather than account-bound.
 *
 * ## Why the Dockerfile is embedded here
 *
 * The runtime cannot read `images/android-emulator-preview/Dockerfile`: the
 * packaged app ships compiled JavaScript, not the repository tree. So the
 * bytes live here, in the same shape `managedRuntimeGuestAgent.ts` embeds the
 * guest agent. The committed Dockerfile stays the reviewable source of truth
 * and `managedEmulatorPreviewImage.test.ts` asserts the two are identical, so
 * the copy cannot drift from the file a reviewer reads.
 *
 * `String.raw` rather than a plain template literal is load-bearing: the
 * Dockerfile's line continuations are trailing backslashes, and in a cooked
 * template a backslash-newline is a line continuation that *deletes* the
 * newline. The result would be a Dockerfile that still looks right in the diff
 * and is wrong in the container.
 *
 * ## What the tag proves
 *
 * The tag is the Dockerfile's own SHA-256, so a changed Dockerfile is a
 * different image rather than a silently reused one, and an unchanged
 * Dockerfile is a cache hit rather than a rebuild. The build also stamps that
 * digest into a label, and a cache hit is only adopted when the label agrees —
 * otherwise something else is sitting on DevHotel's tag, and the image is
 * rebuilt rather than trusted. Content-addressing the tag is what lets this be
 * a cache at all; checking the label is what stops the cache from being a way
 * to substitute an image.
 */
export const MANAGED_EMULATOR_PREVIEW_DOCKERFILE = String.raw`# DevHotel Android Emulator Preview Image
#
# A minimal X11/VNC preview runtime for the managed Android emulator path (#108).
# Ships Xvfb, openbox, x11vnc and novnc/websockify — everything the managed emulator
# container entrypoint script needs to expose the emulator screen over noVNC.
#
# The Android SDK, AVD, and emulator binary are NOT baked into this image.
# They are provisioned by DevHotel from pinned artifacts and mounted as volumes
# at /opt/devhotel/android-sdk and /opt/devhotel/android-avd.
#
# This intentionally keeps the image small and makes it possible to update the
# SDK independently of the preview runtime.
#
# Base: ubuntu:22.04 (Jammy) — pinned by digest in the FROM line.
# The digest is verified by Docker before any layer is pulled.

# renovate: datasource=docker depName=ubuntu versioning=ubuntu
FROM ubuntu:22.04@sha256:829f6df217bcbae2b371026e81711d1a787c61b2967ad09d015063663ebafbf7

LABEL org.opencontainers.image.source="https://github.com/r2cuerdame/DevHotel" \
      org.opencontainers.image.description="DevHotel managed Android emulator X11/VNC preview runtime" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

# Install pinned package versions.
# These are the exact versions from the ubuntu:22.04 (Jammy) apt pool as of the
# image build date. The CI workflow records the resulting image digest, which is
# what the source code pins.
RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends \
        # X11 virtual framebuffer
        xvfb \
        # VNC server attached to the Xvfb display
        x11vnc \
        # Lightweight window manager (makes the emulator window frameless + full-screen)
        openbox \
        # WebSocket bridge: converts VNC to WebSocket for browser-based noVNC
        websockify \
        # noVNC web client (served by websockify --web)
        novnc \
        # Python3 runtime for fit-emulator.py (resizes the emulator Qt window)
        python3 \
        python3-xlib \
        # ffmpeg for captureEmulatorScreen / screen-recording
        ffmpeg \
        # X11 utilities used by fit-emulator.py
        libx11-6 \
        # base64 (POSIX, from coreutils) for decoding the embedded openbox config
        coreutils \
        # curl + unzip: used by the SDK provisioning script to download and extract
        # pinned Android SDK artifacts into the shared SDK volume.
        curl \
        unzip \
        # avdmanager / sdkmanager need a JRE
        openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/*

# Create the SDK root and AVD home that the managed entrypoint script exports.
# These are expected to be bind-mounted from outside; the directories here just
# ensure the mount points exist if the caller does not pre-create them.
RUN mkdir -p /opt/devhotel/android-sdk /opt/devhotel/android-avd

# devhotel runs the emulator as root inside the container (same as docker-android).
# The KVM device is passed with --device /dev/kvm and requires the root user.
USER root

# The entrypoint is overridden by buildManagedEmulatorContainerArgs at runtime.
# This CMD is a safety-net only — it should never run in production.
CMD ["sh", "-c", "echo 'DevHotel managed emulator preview: no entrypoint set' >&2; exit 1"]
`

/**
 * The base layer the preview image is built from, pinned by digest.
 *
 * It is repeated here rather than parsed out of the Dockerfile because it is an
 * assertion, not a derivation: `managedEmulatorPreviewImage.test.ts` checks that
 * the Dockerfile's `FROM` names exactly this, so a base bump has to be made in
 * both places and is therefore visible in review. Docker Hub serves it
 * anonymously, which is the property the whole no-credentials claim rests on.
 */
export const MANAGED_EMULATOR_PREVIEW_BASE_IMAGE =
  'ubuntu:22.04@sha256:829f6df217bcbae2b371026e81711d1a787c61b2967ad09d015063663ebafbf7'

/** Repository half of the local tag. Never pushed, never pulled. */
export const MANAGED_EMULATOR_PREVIEW_REPOSITORY = 'devhotel/android-emulator-preview'

/** Label carrying the Dockerfile digest the image was built from. */
export const MANAGED_EMULATOR_PREVIEW_SOURCE_LABEL = 'devhotel.android-emulator-preview.dockerfile-sha256'

/**
 * SHA-256 of {@link MANAGED_EMULATOR_PREVIEW_DOCKERFILE}, computed from the
 * embedded bytes rather than from the file on disk.
 *
 * Reading the file would make the tag depend on the checkout: a Windows clone
 * with `core.autocrlf=true` holds the same Dockerfile with different bytes, and
 * would build a differently-tagged image that is byte-for-byte the same
 * container. Hashing the embedded string — which is LF whatever git did — keeps
 * one tag per Dockerfile across every platform that runs this.
 */
export const MANAGED_EMULATOR_PREVIEW_DOCKERFILE_SHA256 = createHash('sha256')
  .update(MANAGED_EMULATOR_PREVIEW_DOCKERFILE, 'utf8')
  .digest('hex')

/**
 * The local image reference the managed emulator path uses.
 *
 * Content-addressed by the Dockerfile digest: editing the Dockerfile renames
 * the image, so a runtime holding the previous build keeps it (an unchanged
 * Room still starts) and the next Room builds the new one. Nothing has to
 * invalidate a cache, because nothing shares a name across a change.
 */
export const MANAGED_EMULATOR_PREVIEW_IMAGE_REF = `${MANAGED_EMULATOR_PREVIEW_REPOSITORY}:${MANAGED_EMULATOR_PREVIEW_DOCKERFILE_SHA256.slice(0, 12)}`

/** Where the Dockerfile is staged in the guest, relative to the agent's staging root. */
export function managedEmulatorPreviewStageDir(token: string): string {
  return `android-emulator-preview-${token}`
}

/**
 * `docker build` argv for the preview image.
 *
 * The build context is the staging directory holding only the Dockerfile. That
 * is deliberate and not merely convenient: the Dockerfile has no `COPY` and no
 * `ADD`, so an empty context is the honest description of what the build reads,
 * and a one-file context cannot accidentally send a Room's workspace to the
 * daemon.
 */
export function buildManagedEmulatorPreviewBuildArgs(stageDir: string): string[] {
  return [
    'build',
    '--file',
    `${stageDir}/Dockerfile`,
    '--tag',
    MANAGED_EMULATOR_PREVIEW_IMAGE_REF,
    '--label',
    'devhotel.managed=1',
    '--label',
    'devhotel.image=android-emulator-preview',
    '--label',
    `${MANAGED_EMULATOR_PREVIEW_SOURCE_LABEL}=${MANAGED_EMULATOR_PREVIEW_DOCKERFILE_SHA256}`,
    stageDir
  ]
}

/** `docker image inspect` argv that returns just the source-digest label. */
export function managedEmulatorPreviewInspectArgs(): string[] {
  return [
    'image',
    'inspect',
    '--format',
    `{{index .Config.Labels ${JSON.stringify(MANAGED_EMULATOR_PREVIEW_SOURCE_LABEL)}}}`,
    MANAGED_EMULATOR_PREVIEW_IMAGE_REF
  ]
}

/**
 * Whether an existing image at DevHotel's tag may be reused.
 *
 * `docker image inspect --format` prints `<no value>` for a label that is not
 * set, and an empty line for one set to the empty string; neither is the
 * digest, and both are refused. Only an exact match is a hit, because the point
 * of the check is that the tag alone proves nothing — anyone can tag anything.
 */
export function managedEmulatorPreviewImageIsUsable(inspectStdout: string): boolean {
  return inspectStdout.trim() === MANAGED_EMULATOR_PREVIEW_DOCKERFILE_SHA256
}
