"""Make the mounted volume writable, then run the service as the app user."""
import os
import pwd
import sys

if os.geteuid() == 0:
    user = pwd.getpwnam("app")
    os.chown("/data", user.pw_uid, user.pw_gid)
    os.setgroups([])
    os.setgid(user.pw_gid)
    os.setuid(user.pw_uid)
    os.environ["HOME"] = user.pw_dir
os.execvp(sys.argv[1], sys.argv[1:])
