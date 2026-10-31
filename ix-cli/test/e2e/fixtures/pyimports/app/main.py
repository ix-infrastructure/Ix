from pkg import entry
from pkg.sub.mod import load, Query
import pkg.sub.mod as mod_alias


def read_config():
    return load("config")


def read_alias():
    return mod_alias.load("alias")


class Runner:
    def run(self, q: Query):
        entry()
        return q.where("x")
