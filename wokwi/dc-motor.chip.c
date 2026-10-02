// Wokwi Custom Chip - For docs and examples see:
// https://docs.wokwi.com/chips-api/getting-started
//
// SPDX-License-Identifier: MIT
// Copyright 2023 Jean Lesly Jocelyn

#include "wokwi-api.h"
#include <stdio.h>
#include <stdlib.h>

typedef struct {
  pin_t pin_vcc;
  pin_t pin_gnd;
} chip_state_t;

static void chip_pin_change(void *user_data, pin_t pin, uint32_t value) {
  chip_state_t *chip = (chip_state_t*)user_data;
  if (pin == chip->pin_vcc) {
    if (value) {
      printf("DC Motor: POWER ON (la pompe tourne !)\n");
    } else {
      printf("DC Motor: POWER OFF (la pompe s'arrete)\n");
    }
  }
}

void chip_init(void) {
  chip_state_t *chip = malloc(sizeof(chip_state_t));
  chip->pin_vcc = pin_init("VCC", INPUT_PULLDOWN);
  chip->pin_gnd = pin_init("GND", INPUT_PULLDOWN);

  
  pin_watch_config_t watch_config = {
    .edge = BOTH,
    .pin_change = chip_pin_change,
    .user_data = chip
  };

  
  pin_watch(chip->pin_vcc, &watch_config);

  printf("DC Motor chip initialized!\n");
}
