import os
def boot():
    env = os.environ
    return env['APP_HOST'].strip()
