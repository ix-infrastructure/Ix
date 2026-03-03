package ix.memory.context

import cats.effect.IO
import cats.syntax.parallel._

import ix.memory.db.GraphQueryApi
import ix.memory.model._

class ClaimCollector(queryApi: GraphQueryApi) {

  def collect(nodeIds: Vector[NodeId]): IO[Vector[Claim]] =
    nodeIds
      .parTraverse(id => queryApi.getClaims(id))
      .map(_.flatten.distinctBy(_.id))
}
