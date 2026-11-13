import os
def normalize():
    host = os.environ['APP_HOST'].strip()
    return host, os.environ['APP_PORT'].real, os.environ['APP_HOST']
os.environ['WRITE_ONLY'] = 'localhost'
unrelated = "os.environ['FAKE'].strip()"
