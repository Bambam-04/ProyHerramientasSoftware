// Importación deliberadamente en dos pasos: validar todo y después confirmar el mismo archivo.
// Nunca se evalúan fórmulas provenientes de archivos administrativos.
const ExcelJS = require('exceljs');
const { fail } = require('./core');

const MAX_ROWS = 2000;
function normal(value) {
  return String(value ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\s_\-/]+/g, '');
}
const aliases = {
  matricula: 'matricula',
  nombre: 'nombre',
  nombrecompleto: 'nombre',
  correo: 'correo',
  correoinstitucional: 'correo',
  email: 'correo',
  carrera: 'carrera',
  periodo: 'periodo',
  grupo: 'grupo',
  grupoperiodo: 'periodo',
  estado: 'estado',
  categoria: 'categoria',
  caracteristicas: 'caracteristicas',
  caracteristicastecnicas: 'caracteristicas',
  fotografia: 'fotografia',
  foto: 'fotografia',
  cantidad: 'cantidad',
  cantidadtotal: 'cantidad',
  unidades: 'cantidad',
  maxhoras: 'maxHoras',
  tiempomaximoprestamo: 'maxHoras',
  tiempomaximodeprestamo: 'maxHoras',
  password: 'password',
  contrasena: 'password',
};

function csvRows(input) {
  const source = input.replace(/^\uFEFF/, '');
  const firstLine = source.split(/\r?\n/, 1)[0];
  const separator = firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let closed = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else cell += c;
    } else if (c === '"') {
      if (cell || closed) fail(400, 'El CSV contiene comillas fuera de un campo entrecomillado.');
      quoted = true;
    } else if (c === separator || c === '\n' || c === '\r') {
      row.push(cell);
      cell = '';
      closed = false;
      if (c !== separator) {
        if (c === '\r' && source[i + 1] === '\n') i++;
        if (row.some((v) => v.trim())) rows.push(row);
        row = [];
      }
    } else {
      if (closed && !/\s/.test(c))
        fail(400, 'El CSV contiene texto después del cierre de un campo.');
      if (!closed) cell += c;
    }
    if (rows.length > MAX_ROWS + 1)
      fail(400, `El archivo admite hasta ${MAX_ROWS} registros por carga.`);
  }
  if (quoted) fail(400, 'El CSV contiene un campo entrecomillado sin cerrar.');
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

async function parseImport(body, kind) {
  if (typeof body.contenido !== 'string' || !body.contenido.trim())
    fail(400, 'Selecciona un archivo CSV o Excel con contenido.');
  const formato = String(body.formato || 'csv').toLowerCase();
  if (Buffer.byteLength(body.contenido, 'utf8') > (formato === 'xlsx' ? 8 : 6) * 1024 * 1024)
    fail(413, 'El archivo supera el tamaño máximo de 6 MB.');
  let rows;
  if (formato === 'csv') rows = csvRows(body.contenido);
  else if (formato === 'xlsx') {
    if (!/^[a-zA-Z0-9+/=\r\n]+$/.test(body.contenido))
      fail(400, 'El archivo Excel no tiene una codificación válida.');
    const book = new ExcelJS.Workbook();
    try {
      await book.xlsx.load(Buffer.from(body.contenido, 'base64'));
    } catch {
      fail(400, 'No se pudo leer el archivo. Usa un libro Excel .xlsx válido.');
    }
    const sheet = book.worksheets[0];
    if (!sheet) fail(400, 'El libro Excel no contiene hojas.');
    if (sheet.rowCount > MAX_ROWS + 1 || sheet.columnCount > 30)
      fail(400, `La hoja admite hasta ${MAX_ROWS} filas y 30 columnas.`);
    rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = [];
      for (let c = 1; c <= sheet.columnCount; c++) {
        const cell = row.getCell(c);
        if (
          cell.type === ExcelJS.ValueType.Formula ||
          (cell.value && typeof cell.value === 'object' && 'formula' in cell.value)
        )
          fail(400, `La fila ${row.number} contiene fórmulas. Importa únicamente valores.`);
        values.push(cell.text || '');
      }
      if (values.some((v) => v.trim())) rows.push(values);
    });
  } else fail(400, 'El formato debe ser csv o xlsx.');
  if (rows.length < 2) fail(400, 'El archivo debe contener encabezados y al menos un registro.');
  if (rows.length > MAX_ROWS + 1)
    fail(400, `El archivo admite hasta ${MAX_ROWS} registros por carga.`);
  const headers = rows[0].map((h) => aliases[normal(h)] || normal(h));
  if (new Set(headers).size !== headers.length)
    fail(400, 'El archivo contiene encabezados duplicados.');
  const required =
    kind === 'alumnos'
      ? ['matricula', 'nombre', 'correo', 'carrera', 'periodo', 'estado']
      : ['nombre', 'categoria', 'caracteristicas', 'cantidad', 'maxHoras'];
  const missing = required.filter(
    (h) =>
      !headers.includes(h) && !(kind === 'alumnos' && h === 'periodo' && headers.includes('grupo')),
  );
  if (missing.length) fail(400, `Faltan columnas obligatorias: ${missing.join(', ')}.`);
  const errors = [];
  const records = rows.slice(1).map((row, index) => {
    const record = { fila: index + 2 };
    if (row.length > headers.length && row.slice(headers.length).some((v) => v.trim()))
      errors.push({ fila: index + 2, error: 'La fila contiene más columnas que los encabezados.' });
    headers.forEach((key, col) => {
      record[key] = String(row[col] ?? '').trim();
    });
    if (kind === 'alumnos' && !record.periodo && record.grupo) record.periodo = record.grupo;
    for (const value of Object.values(record)) {
      if (typeof value === 'string' && /^[=+@\t\r]/.test(value))
        errors.push({
          fila: index + 2,
          error:
            'La fila contiene un valor con formato de fórmula. Importa únicamente texto o números.',
        });
    }
    return record;
  });
  return { records, errors };
}

function safeCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return value;
  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

module.exports = { parseImport, normal, safeCell };
