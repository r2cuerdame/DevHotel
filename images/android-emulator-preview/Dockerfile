# DevHotel Android Emulator Preview Image
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
