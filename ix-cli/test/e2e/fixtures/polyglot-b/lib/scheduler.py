from lib.clock import now


class Scheduler:
    def __init__(self):
        self.jobs = []

    def every(self, seconds, job):
        self.jobs.append((now() + seconds, job))

    def due(self):
        current = now()
        return [job for at, job in self.jobs if at <= current]
