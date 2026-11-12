package arithmetic

import org.scalatest.funsuite.AnyFunSuite
import arithmetic.ScalaCalc

class BehaviorSpec extends AnyFunSuite {
  test("doubles") { assert(ScalaCalc.twice(2) == 4) }
}
