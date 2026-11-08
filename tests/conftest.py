import os
import sys
import tempfile

# One throwaway SQLite database for the whole test run
os.environ.setdefault("DATABASE_URL", "sqlite:///" + os.path.join(tempfile.mkdtemp(), "test.db"))
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

# Fake Google credentials so the Google sign-in routes are switched on in tests
os.environ.setdefault("GOOGLE_CLIENT_ID", "test-client.apps.googleusercontent.com")
os.environ.setdefault("GOOGLE_CLIENT_SECRET", "test-secret")

# The account that receives trees made by the seed commands (see auth.claim_unowned_trees)
os.environ.setdefault("OWNER_EMAIL", "owner@example.com")
