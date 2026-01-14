from fastapi import FastAPI
from sqlalchemy import create_engine, text

DATABASE_URL = "postgresql://postgres:PAROL@localhost:5432/postgres"

engine = create_engine(DATABASE_URL)

app = FastAPI()

@app.get("/")
def root():
    return {"status": "OK"}

@app.get("/users")
def get_users():
    with engine.connect() as conn:
        result = conn.execute(text("SELECT * FROM users"))
        return [dict(row._mapping) for row in result]
