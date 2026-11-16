-- La aplicación sólo puede anexar acciones. No existe ruta para editar la bitácora.
CREATE OR REPLACE FUNCTION cima_auditoria_inmutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'La bitácora de CIMA es inmutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cima_actividad_inmutable ON "Actividad";
CREATE TRIGGER cima_actividad_inmutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "Actividad"
FOR EACH STATEMENT EXECUTE FUNCTION cima_auditoria_inmutable();
