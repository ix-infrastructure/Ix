package ix.memory.ingestion

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import ix.memory.ingestion.parsers.TreeSitterPythonParser

class TreeSitterPythonParserSpec extends AnyFlatSpec with Matchers {
  val parser = new TreeSitterPythonParser()

  "TreeSitterPythonParser" should "extract classes and functions from Python source" in {
    val source = scala.io.Source.fromResource("fixtures/billing_service.py").mkString
    val result = parser.parse("billing_service.py", source)
    val names = result.entities.map(_.name)
    names should contain("BillingService")
    names should contain("process_payment")
    names should contain("retry_handler")
    names should contain("standalone_function")
  }

  it should "extract import relationships" in {
    val source = scala.io.Source.fromResource("fixtures/billing_service.py").mkString
    val result = parser.parse("billing_service.py", source)
    val imports = result.relationships.filter(_.predicate == "IMPORTS")
    imports.size should be >= 2
  }

  it should "extract class-to-method CONTAINS edges" in {
    val source = scala.io.Source.fromResource("fixtures/billing_service.py").mkString
    val result = parser.parse("billing_service.py", source)
    val defines = result.relationships.filter(_.predicate == "CONTAINS")
    defines.size should be >= 3
  }

  it should "extract function call relationships" in {
    val source = scala.io.Source.fromResource("fixtures/billing_service.py").mkString
    val result = parser.parse("billing_service.py", source)
    val calls = result.relationships.filter(_.predicate == "CALLS")
    calls.size should be >= 1
  }
}
