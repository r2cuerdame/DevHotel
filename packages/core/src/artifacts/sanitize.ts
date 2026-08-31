import {
  zAndroidScreenshotArtifactMetadata,
  type AndroidScreenshotArtifactMetadata
} from '@devhotel/shared'
import { redactSecrets } from '../diagnostics/redact'

/** Redact only guest-controlled prose; schema-bearing identifiers stay exact. */
export function sanitizeAndroidScreenshotArtifactMetadata(value: unknown): AndroidScreenshotArtifactMetadata {
  const metadata = zAndroidScreenshotArtifactMetadata.parse(value)
  return zAndroidScreenshotArtifactMetadata.parse({
    ...metadata,
    device: {
      ...metadata.device,
      model: metadata.device.model === null ? null : redactSecrets(metadata.device.model),
      androidVersion:
        metadata.device.androidVersion === null ? null : redactSecrets(metadata.device.androidVersion)
    }
  })
}
