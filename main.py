import os
import psycopg2
from fastapi import FastAPI
from dotenv import load_dotenv

# .env ni yuklash
load_dotenv()

app = FastAPI()

# PostgreSQL ulanish
conn = psycopg2.connect(
    host=os.getenv("DB_HOST"),
    port=os.getenv("DB_PORT"),
    database=os.getenv("DB_NAME"),
    user=os.getenv("DB_USER"),
    password=os.getenv("DB_PASSWORD")
)

# Server ishlayaptimi tekshirish
@app.get("/")
def root():
    return {
        "status": "OK",
        "message": "Backend ishlayapti, PostgreSQL ulangan"
    }

# Users jadvalidan ma'lumot olish
@app.get("/users")
def get_users():
    with conn.cursor() as cur:
        cur.execute("""
            SELECT username, phone, role, created_at
            FROM users
            ORDER BY created_at DESC
        """)
        rows = cur.fetchall()

    return [
        {
            "username": r[0],
            "phone": r[1],
            "role": r[2],
            "created_at": r[3]
        }
        for r in rows
    ]
