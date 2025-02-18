import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const app = express();
const port = 4000; 

// Middleware
app.use(cors());
app.use(express.json());

// Configuración de constantes
const MAX_REFRESH_ATTEMPTS = 2;
let refreshAttempts = 0;

// Inicialización de Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    }
);

// Función para añadir timestamp a los logs
function logWithTimestamp(message) {
    const now = new Date();
    console.log(`[${now.toISOString()}] ${message}`);
}

// Función para obtener información de la fecha
function getDateInfo(date) {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const d = new Date(date);
    return {
        date: d,
        dayOfWeek: days[d.getDay()],
        isToday: new Date().toDateString() === d.toDateString()
    };
}

// Función para obtener horarios de negocio
function getBusinessHours(businessHours, dayOfWeek) {
    const daySchedule = businessHours[dayOfWeek];
    if (!daySchedule || !daySchedule[0].enabled) {
        logWithTimestamp(`❌ El día ${dayOfWeek} no está habilitado para citas`);
        return null;
    }
    logWithTimestamp(`📅 Horario para ${dayOfWeek}:`);
    logWithTimestamp(`   Apertura: ${daySchedule[0].open}`);
    logWithTimestamp(`   Cierre: ${daySchedule[0].close}`);
    logWithTimestamp(`   Estado: ${daySchedule[0].enabled ? 'Habilitado' : 'Deshabilitado'}`);
    
    return {
        open: daySchedule[0].open,
        close: daySchedule[0].close
    };
}

// Función para generar slots de tiempo disponibles
function generateTimeSlots(openTime, closeTime, targetDate) {
    const slots = [];
    const [openHour, openMinute] = openTime.split(':').map(Number);
    const [closeHour, closeMinute] = closeTime.split(':').map(Number);
    
    let currentSlot = new Date(targetDate);
    currentSlot.setHours(openHour, openMinute, 0, 0);
    
    const endTime = new Date(targetDate);
    endTime.setHours(closeHour, closeMinute, 0, 0);
    
    while (currentSlot < endTime) {
        const slotEnd = new Date(currentSlot);
        slotEnd.setHours(currentSlot.getHours() + 1);
        
        if (slotEnd <= endTime) {
            slots.push({
                start: new Date(currentSlot),
                end: slotEnd
            });
        }
        currentSlot = new Date(slotEnd);
    }
    return slots;
}

// Función para verificar conflictos de horarios
function isSlotConflicting(slot, events) {
    return events.some(event => {
        const eventStart = new Date(event.start.dateTime || event.start.date);
        const eventEnd = new Date(event.end.dateTime || event.end.date);
        
        const slotStartTime = slot.start.getHours() * 60 + slot.start.getMinutes();
        const slotEndTime = slot.end.getHours() * 60 + slot.end.getMinutes();
        const evStartTime = eventStart.getHours() * 60 + eventStart.getMinutes();
        const evEndTime = eventEnd.getHours() * 60 + eventEnd.getMinutes();

        return (
            (evStartTime < slotEndTime && evEndTime > slotStartTime) ||
            (evStartTime === slotStartTime) ||
            (evEndTime === slotEndTime)
        );
    });
}

// Función para actualizar el token en la base de datos
async function updateAccessTokenInDB(finalUser, newAccessToken) {
    try {
        const { error } = await supabase
            .from('clients')
            .update({ google_calendar_token: newAccessToken })
            .eq('final_user', finalUser);
        
        if (error) {
            logWithTimestamp(`Error actualizando token en DB: ${JSON.stringify(error)}`);
        } else {
            logWithTimestamp('Token actualizado correctamente en la base de datos');
        }
    } catch (updateError) {
        logWithTimestamp(`Excepción al actualizar token en DB: ${updateError.message}`);
    }
}

// Función para refrescar el access token
async function refreshAccessToken(refreshToken, finalUser) {
    const url = 'https://oauth2.googleapis.com/token';
    const params = new URLSearchParams();

    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !refreshToken) {
        const errorDetails = [
            !process.env.GOOGLE_CLIENT_ID ? 'GOOGLE_CLIENT_ID está vacío' : '',
            !process.env.GOOGLE_CLIENT_SECRET ? 'GOOGLE_CLIENT_SECRET está vacío' : '',
            !refreshToken ? 'refreshToken está vacío' : ''
        ].filter(Boolean).join(', ');
        
        throw new Error(`Credenciales incompletas para refresh token: ${errorDetails}`);
    }

    params.append('client_id', process.env.GOOGLE_CLIENT_ID);
    params.append('client_secret', process.env.GOOGLE_CLIENT_SECRET);
    params.append('refresh_token', refreshToken);
    params.append('grant_type', 'refresh_token');

    const response = await axios.post(url, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (finalUser) {
        await updateAccessTokenInDB(finalUser, response.data.access_token);
    }

    return response.data.access_token;
}

// Función para obtener eventos del calendario
async function getCalendarEvents(calendarId, eventStartTime, accessToken, businessHours) {
    const dateInfo = getDateInfo(eventStartTime);
    const businessHoursForDay = getBusinessHours(businessHours, dateInfo.dayOfWeek);
    
    if (!businessHoursForDay) {
        return { availableSlots: [], existingEvents: [], message: "Día no disponible para citas" };
    }

    const startOfDay = new Date(eventStartTime);
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date(eventStartTime);
    endOfDay.setHours(23, 59, 59, 999);

    try {
        const url = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`;
        const params = {
            timeMin: startOfDay.toISOString(),
            timeMax: endOfDay.toISOString(),
            singleEvents: true,
            orderBy: 'startTime'
        };
        
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        };

        const response = await axios.get(url, { headers, params });
        const existingEvents = response.data.items || [];
        const targetDate = new Date(eventStartTime);
        const availableSlots = generateTimeSlots(
            businessHoursForDay.open, 
            businessHoursForDay.close,
            targetDate
        );

        const slotsStatus = availableSlots.map(slot => {
            const conflictingEvents = existingEvents.filter(event => {
                const eventStart = new Date(event.start.dateTime || event.start.date);
                const eventEnd = new Date(event.end.dateTime || event.end.date);
                
                const slotStartTime = slot.start.getHours() * 60 + slot.start.getMinutes();
                const slotEndTime = slot.end.getHours() * 60 + slot.end.getMinutes();
                const evStartTime = eventStart.getHours() * 60 + eventStart.getMinutes();
                const evEndTime = eventEnd.getHours() * 60 + eventEnd.getMinutes();

                return (
                    (evStartTime < slotEndTime && evEndTime > slotStartTime) ||
                    (evStartTime === slotStartTime) ||
                    (evEndTime === slotEndTime)
                );
            });

            return {
                slot,
                isAvailable: conflictingEvents.length === 0,
                conflicts: conflictingEvents
            };
        });

        const freeSlots = slotsStatus.filter(status => status.isAvailable).map(status => status.slot);

        return {
            availableSlots: freeSlots,
            existingEvents: existingEvents,
            message: freeSlots.length > 0 ? 
                `Se encontraron ${freeSlots.length} slots disponibles` : 
                "No hay slots disponibles para este día"
        };

    } catch (error) {
        if (error.response?.status === 401) {
            throw { status: 401, message: 'Token expirado' };
        }
        throw error;
    }
}

// Endpoint para obtener slots disponibles
app.post('/api/calendar/available-slots', async (req, res) => {
    try {
        const { final_user, date } = req.body;
        
        if (!final_user || !date) {
            return res.status(400).json({
                success: false,
                message: 'Se requiere final_user y date'
            });
        }

        const { data: clients, error: searchError } = await supabase
            .from('clients')
            .select('google_calendar_token, google_calendar_id, refresh_token, business_hours')
            .eq('final_user', final_user);

        if (searchError || !clients?.length) {
            return res.status(404).json({
                success: false,
                message: 'Usuario no encontrado'
            });
        }

        const { google_calendar_token, google_calendar_id, refresh_token, business_hours } = clients[0];

        try {
            const calendarResponse = await getCalendarEvents(
                google_calendar_id,
                date,
                google_calendar_token,
                business_hours
            );

            return res.json({
                success: true,
                availableSlots: calendarResponse.availableSlots,
                message: calendarResponse.message
            });

        } catch (error) {
            if (error.status === 401) {
                const newToken = await refreshAccessToken(refresh_token, final_user);
                const calendarResponse = await getCalendarEvents(
                    google_calendar_id,
                    date,
                    newToken,
                    business_hours
                );

                return res.json({
                    success: true,
                    availableSlots: calendarResponse.availableSlots,
                    message: calendarResponse.message
                });
            }
            throw error;
        }

    } catch (error) {
        console.error('Error al obtener slots:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al obtener slots disponibles',
            error: error.message
        });
    }
});

// Endpoint para agendar cita
app.post('/api/calendar/schedule', async (req, res) => {
    try {
        const { final_user, eventDetails } = req.body;

        if (!final_user || !eventDetails) {
            return res.status(400).json({
                success: false,
                message: 'Se requiere final_user y eventDetails'
            });
        }

        const requiredFields = ['summary', 'description', 'start', 'end'];
        const missingFields = requiredFields.filter(field => !eventDetails[field]);

        if (missingFields.length > 0) {
            return res.status(400).json({
                success: false,
                message: `Campos requeridos faltantes: ${missingFields.join(', ')}`
            });
        }

        const { data: clients, error: searchError } = await supabase
            .from('clients')
            .select('google_calendar_token, google_calendar_id, refresh_token, business_hours')
            .eq('final_user', final_user);

        if (searchError || !clients?.length) {
            return res.status(404).json({
                success: false,
                message: 'Usuario no encontrado'
            });
        }

        const { google_calendar_token, google_calendar_id, refresh_token, business_hours } = clients[0];

        try {
            // Verificar disponibilidad
            const calendarResponse = await getCalendarEvents(
                google_calendar_id,
                eventDetails.start.dateTime,
                google_calendar_token,
                business_hours
            );

            const requestedSlot = {
                start: new Date(eventDetails.start.dateTime),
                end: new Date(eventDetails.end.dateTime)
            };

            const hasConflict = isSlotConflicting(requestedSlot, calendarResponse.existingEvents);

            if (hasConflict) {
                return res.json({
                    success: false,
                    message: 'El horario solicitado ya está ocupado',
                    availableSlots: calendarResponse.availableSlots
                });
            }

            // Crear el evento
            const url = `https://www.googleapis.com/calendar/v3/calendars/${google_calendar_id}/events`;
            const headers = {
                'Authorization': `Bearer ${google_calendar_token}`,
                'Content-Type': 'application/json'
            };

            const response = await axios.post(url, eventDetails, { headers });

            return res.json({
                success: true,
                message: 'Cita agendada exitosamente',
                event: response.data
            });

        } catch (error) {
            if (error.status === 401) {
                const newToken = await refreshAccessToken(refresh_token, final_user);
                const url = `https://www.googleapis.com/calendar/v3/calendars/${google_calendar_id}/events`;
                const headers = {
                    'Authorization': `Bearer ${newToken}`,
                    'Content-Type': 'application/json'
                };

                const response = await axios.post(url, eventDetails, { headers });

                return res.json({
                    success: true,
                    message: 'Cita agendada exitosamente',
                    event: response.data
                });
            }
            throw error;
        }

    } catch (error) {
        console.error('Error al agendar cita:', error);
        return res.status(500).json({
            success: false,
            message: 'Error al agendar la cita',
            error: error.message
        });
    }
});

app.listen(port, () => {
    console.log(`Servidor calendario corriendo en puerto ${port}`);
});
