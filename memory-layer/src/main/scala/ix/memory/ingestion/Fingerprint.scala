package ix.memory.ingestion

import java.security.MessageDigest

object Fingerprint {

  /** Compute a normalized content fingerprint from signature + body.
   *  Returns a 32-char hex string (first 16 bytes of SHA-256).
   */
  def compute(signature: String, body: String): String = {
    val normalized = (signature.trim + "\n" + body.trim)
      .replaceAll("\\s+", " ")
      .trim
    val digest = MessageDigest.getInstance("SHA-256")
    digest.digest(normalized.getBytes("UTF-8"))
      .take(16)
      .map("%02x".format(_))
      .mkString
  }
}
