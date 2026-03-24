package ix.memory.ingestion

import java.nio.file.Paths

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class FileDiscoverySpec extends AnyFlatSpec with Matchers {

  "extensionsFor(None)" should "default to parser-supported file types" in {
    val extensions = FileDiscovery.extensionsFor(None)

    extensions should contain allOf (".py", ".ts", ".tsx", ".scala", ".sc", ".json", ".yaml", ".yml", ".toml", ".md")
    extensions should not contain ".txt"
    extensions should not contain ".ini"
    extensions should not contain ".sbt"
  }

  "matchesFilter" should "exclude unsupported generic-text files by default" in {
    val extensions = FileDiscovery.extensionsFor(None)

    FileDiscovery.matchesFilter(Paths.get("README.md"), extensions) shouldBe true
    FileDiscovery.matchesFilter(Paths.get("Dockerfile"), extensions) shouldBe false
    FileDiscovery.matchesFilter(Paths.get("notes.txt"), extensions) shouldBe false
  }
}
