const { log } = require('../utils/logger');

/**
 * تقريب القيمة (السعر) إلى أقرب مضاعف لـ tickSize للأسفل.
 * هذا يضمن التوافق مع فلاتر الأسعار في البورصة (Floor to Multiplier).
 * @param {number} value - القيمة المراد تقريبها (السعر).
 * @param {number} tickSize - أصغر فرق سعري مسموح به (مثل 0.01).
 * @returns {number} القيمة المقربة.
 */
function roundToTickSize(value, tickSize) {
    if (tickSize <= 0) return value;
    
    // حساب عدد الأرقام العشرية في tickSize
    const precision = Math.max(0, (tickSize.toString().split('.')[1] || '').length);

    // 1. قسمة القيمة على حجم الخطوة
    const multiplier = value / tickSize;
    
    // 2. التقريب للأسفل (إزالة الأجزاء العشرية الزائدة)
    const roundedMultiplier = Math.floor(multiplier);
    
    // 3. الضرب مرة أخرى في tickSize
    let roundedValue = roundedMultiplier * tickSize;

    // 4. إصلاح مشكلة دقة الأرقام العشرية (Floating Point Precision)
    roundedValue = parseFloat(roundedValue.toFixed(precision));
    
    return roundedValue;
}

/**
 * تقريب القيمة (الكمية) إلى أقرب مضاعف لـ stepSize للأسفل.
 * @param {number} value - القيمة المراد تقريبها (الكمية).
 * @param {number} stepSize - أصغر كمية مسموح بها (مثل 0.0001).
 * @returns {number} القيمة المقربة.
 */
function roundToStepSize(value, stepSize) {
    if (stepSize <= 0) return value;
    
    const precision = Math.max(0, (stepSize.toString().split('.')[1] || '').length);

    const multiplier = value / stepSize;
    const roundedMultiplier = Math.floor(multiplier);
    let roundedValue = roundedMultiplier * stepSize;

    // إصلاح مشكلة دقة الأرقام العشرية (Floating Point Precision)
    roundedValue = parseFloat(roundedValue.toFixed(precision));

    return roundedValue;
}

module.exports = { roundToTickSize, roundToStepSize };