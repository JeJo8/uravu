import os
import sys
import tempfile

# One throwaway SQLite database for the whole test run
os.environ.setdefault("DATABASE_URL", "sqlite:///" + os.path.join(tempfile.mkdtemp(), "test.db"))
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
