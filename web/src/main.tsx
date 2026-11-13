import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const contenedor = document.getElementById("root");
if (!contenedor) throw new Error("No se encontró #root");

createRoot(contenedor).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
