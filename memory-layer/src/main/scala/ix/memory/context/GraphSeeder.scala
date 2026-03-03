package ix.memory.context

import cats.effect.IO
import cats.syntax.parallel._

import ix.memory.db.GraphQueryApi
import ix.memory.model._

class GraphSeeder(queryApi: GraphQueryApi) {

  def seed(terms: Vector[String],
           asOfRev: Option[Rev] = None): IO[Vector[GraphNode]] =
    terms
      .parTraverse(term => queryApi.searchNodes(term))
      .map(_.flatten.distinctBy(_.id))
}
