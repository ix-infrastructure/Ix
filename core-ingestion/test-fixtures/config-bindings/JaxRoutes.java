import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;

@Path("/api/")
class JaxRoutes {
  @GET @Path("/health")
  String health() { return "ok"; }
  @POST @Path(value = "jobs")
  String jobs() { return "ok"; }
  @GET @Path("")
  String root() { return "ok"; }
}

class PlainJax {
  @GET @Path("/plain")
  String health() { return "ok"; }
}

@Path(value = "v1")
class RelativeJax {
  @jakarta.ws.rs.GET @Path("health")
  String health() { return "ok"; }
}

@Path(BASE)
class DynamicJax {
  @GET @Path("/dynamic")
  String health() { return "ok"; }
}
