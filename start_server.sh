#!/usr/bin/env bash

uvicorn app.main:app --reload --port 8500 &

npm run dev