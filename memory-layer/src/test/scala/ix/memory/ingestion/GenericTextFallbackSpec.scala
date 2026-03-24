package ix.memory.ingestion

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class GenericTextFallbackSpec extends AnyFlatSpec with Matchers {

  "GenericTextFallback" should "store compact metadata instead of raw content" in {
    val parsed = GenericTextFallback.parse("notes.txt", "first line\nsecond line\n")
    val entity = parsed.entities.head

    entity.attrs.keySet should contain allOf ("file_name", "line_count", "preview")
    entity.attrs.keySet should not contain "content"
    entity.attrs("preview").asString shouldBe Some("first line")
    entity.contentFingerprint should not be empty
  }
}
